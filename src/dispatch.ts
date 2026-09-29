import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { Channel, GetMessage } from "amqplib";
import { forward } from "./forward.js";
import { enter, isOverloaded, leave } from "./overload.js";
import { EXCHANGE, QUEUES } from "./queue.js";
import type { Tier } from "./config.js";
import { recordRequest } from "./metrics.js";

// Load shedding. A held request costs an open socket plus its req/res objects,
// so the wait is bounded two ways:
// - MAX_QUEUE_LENGTH (per tier): beyond it, new overload traffic gets 503
//   immediately instead of joining a queue that can't drain in time.
// - MAX_QUEUE_WAIT_MS: a held request not dequeued by then gets 503.
// Both are counted in-process, next to `pending`, rather than enforced by
// RabbitMQ (x-max-length). A request that times out or disconnects frees its
// slot here immediately, while its id would keep occupying a broker slot
// until the consumer reached it. The in-process count also avoids a
// publisher-confirm round trip per enqueue. pending already makes this
// single-instance, so a local counter loses nothing.
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isInteger(n) && n >= 0 ? n : fallback;
}

const DEFAULT_MAX_QUEUE_LENGTH = envInt("MAX_QUEUE_LENGTH", 1000);
export const MAX_QUEUE_LENGTH: Record<Tier, number> = {
  T1: envInt("MAX_QUEUE_LENGTH_T1", DEFAULT_MAX_QUEUE_LENGTH),
  T2: envInt("MAX_QUEUE_LENGTH_T2", DEFAULT_MAX_QUEUE_LENGTH),
  T3: envInt("MAX_QUEUE_LENGTH_T3", DEFAULT_MAX_QUEUE_LENGTH),
};
export const MAX_QUEUE_WAIT_MS = envInt("MAX_QUEUE_WAIT_MS", 5000);

// Every held request leaves the queue (served or shed) within MAX_QUEUE_WAIT_MS,
// so that is when a slot is guaranteed to have opened up.
const RETRY_AFTER_S = Math.max(1, Math.ceil(MAX_QUEUE_WAIT_MS / 1000));

type Held = { req: Request; res: Response; tier: Tier; timer: NodeJS.Timeout };

// Requests waiting in the priority queue, keyed by a generated message id.
// The consumer looks up the held { req, res } by this id to forward and
// respond. In-process map => single Bouncer instance (by design).
const pending = new Map<string, Held>();

// Live waiters per tier (== pending entries of that tier). RabbitMQ may still
// hold ids for requests that already left; those don't count.
const waiting: Record<Tier, number> = { T1: 0, T2: 0, T3: 0 };

// Take a request out of the queue exactly once, whichever path gets there
// first: the consumer, the wait timeout, or the client disconnecting.
// Returns undefined if it was already taken.
function release(id: string): Held | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  pending.delete(id);
  clearTimeout(entry.timer);
  waiting[entry.tier]--;
  return entry;
}

function shed(res: Response, tier: Tier, error: "queue_full" | "queue_timeout") {
  recordRequest(tier, "shed");
  res.setHeader("Retry-After", RETRY_AFTER_S);
  res.status(503).json({ error });
}

// Terminal handler after authenticate + rateLimit: forward directly when the
// backend has capacity, otherwise enqueue by tier priority and hold the
// connection open until the consumer processes it (or it is shed).
export function createDispatch(channel: Channel) {
  return function dispatch(req: Request, res: Response) {
    // tenant is guaranteed set by authenticate (runs earlier in the chain).
    const tenant = req.tenant!;
    const tier = tenant.tier;

    if (!isOverloaded()) {
      // Count in-flight synchronously here (before the next concurrent request's
      // overload check), then forward. leave() when the backend call settles.
      recordRequest(tier, "forwarded");
      enter();
      void forward(req, res).finally(leave);
      return;
    }

    // Overloaded and this tier's queue is full: shed now rather than queue.
    if (waiting[tier] >= MAX_QUEUE_LENGTH[tier]) {
      return shed(res, tier, "queue_full");
    }

    // Overloaded: enqueue.
    const id = randomUUID();
    const timer = setTimeout(() => {
      const entry = release(id);
      if (entry) shed(entry.res, tier, "queue_timeout");
    }, MAX_QUEUE_WAIT_MS);
    pending.set(id, { req, res, tier, timer });
    waiting[tier]++;

    // Drop the pending entry if the client disconnects before we answer.
    // (Also fires after a normal response, where release is a no-op.)
    res.on("close", () => release(id));

    // Publish the id to the tenant's tier queue (routing key = tier).
    channel.publish(EXCHANGE, tier, Buffer.from(id));
    recordRequest(tier, "queued");
  };
}

// Highest priority first: drain T3 fully, then T2, then T1.
const PRIORITY_ORDER: Tier[] = ["T3", "T2", "T1"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pull one message from the highest-priority non-empty queue, or false.
async function getNextByPriority(channel: Channel): Promise<GetMessage | false> {
  for (const tier of PRIORITY_ORDER) {
    const msg = await channel.get(QUEUES[tier], { noAck: false });
    if (msg) return msg;
  }
  return false;
}

// Forward a dequeued request to the backend (answers the waiting client), then
// ack. Always acks: an id whose request already left the queue (timed out,
// client disconnected, or lost in a restart) has nothing to answer, but the
// message is still consumed.
async function processMessage(channel: Channel, msg: GetMessage): Promise<void> {
  const id = msg.content.toString();
  const entry = release(id);
  if (!entry) {
    // Already shed / disconnected — skip without using a backend slot.
    channel.ack(msg);
    return;
  }
  // Count in-flight synchronously (mirrors the direct path) before forwarding.
  enter();
  try {
    await forward(entry.req, entry.res);
  } catch (err) {
    console.error("Consumer process error:", err);
  } finally {
    leave();
    channel.ack(msg);
  }
}

// Worker loop: drain queues by priority, paced by the in-flight cap. Only pulls
// a queued request when the backend has a free slot; fires processing without
// awaiting so it can fill the backend up to the cap, highest priority first.
export function startConsumer(channel: Channel): void {
  (async () => {
    while (true) {
      try {
        if (isOverloaded()) {
          await sleep(10); // backend at capacity — wait for a slot
          continue;
        }
        const msg = await getNextByPriority(channel);
        if (!msg) {
          await sleep(10); // nothing queued — idle
          continue;
        }
        void processMessage(channel, msg);
      } catch (err) {
        console.error("Consumer loop error:", err);
        await sleep(100);
      }
    }
  })();
}
