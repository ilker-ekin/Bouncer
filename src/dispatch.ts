import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { Channel, GetMessage } from "amqplib";
import { forward } from "./forward";
import { enter, isOverloaded, leave } from "./overload";
import { EXCHANGE, QUEUES } from "./queue";
import type { Tier } from "./config";

// Requests waiting in the priority queue, keyed by a generated message id.
// The consumer (next step) looks up the held { req, res } by this id to forward
// and respond. In-process map => single Bouncer instance (by design).
const pending = new Map<string, { req: Request; res: Response }>();

// Terminal handler after authenticate + rateLimit: forward directly when the
// backend has capacity, otherwise enqueue by tier priority and hold the
// connection open until the consumer processes it.
export function createDispatch(channel: Channel) {
  return function dispatch(req: Request, res: Response) {
    if (!isOverloaded()) {
      // Count in-flight synchronously here (before the next concurrent request's
      // overload check), then forward. leave() when the backend call settles.
      enter();
      void forward(req, res).finally(leave);
      return;
    }

    // Overloaded: enqueue. tenant is guaranteed set by authenticate.
    const tenant = req.tenant!;
    const id = randomUUID();
    pending.set(id, { req, res });

    // Drop the pending entry if the client disconnects before we answer.
    res.on("close", () => pending.delete(id));

    // Publish the id to the tenant's tier queue (routing key = tier).
    channel.publish(EXCHANGE, tenant.tier, Buffer.from(id));
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
// ack. Always acks — an orphaned id (client gone / restart) has nothing to
// answer but the message is still consumed.
async function processMessage(channel: Channel, msg: GetMessage): Promise<void> {
  const id = msg.content.toString();
  const entry = pending.get(id);
  if (!entry) {
    // Orphaned (client gone / restart) — nothing to answer.
    channel.ack(msg);
    return;
  }
  pending.delete(id);
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
