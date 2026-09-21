import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { Channel } from "amqplib";
import { forward } from "./forward";
import { isOverloaded } from "./overload";
import { EXCHANGE } from "./queue";

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
      return forward(req, res);
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
