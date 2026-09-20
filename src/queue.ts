import type { Channel } from "amqplib";
import type { Tier } from "./config";

// Direct exchange: routes each message to the queue whose binding key exactly
// matches the message's routing key (the tier).
export const EXCHANGE = "requests";

// One queue per tier. Routing key = the tier itself ("T1"/"T2"/"T3").
export const QUEUES: Record<Tier, string> = {
  T1: "requests.T1",
  T2: "requests.T2",
  T3: "requests.T3",
};

const TIERS: Tier[] = ["T1", "T2", "T3"];

// Declare the exchange, the three tier queues, and their bindings.
// Transient (durable: false): a queued request is only meaningful while the
// client's HTTP connection is open, so there is nothing worth persisting across
// a broker restart. assert* is idempotent — safe to run on every startup.
export async function declareTopology(channel: Channel) {
  await channel.assertExchange(EXCHANGE, "direct", { durable: false });
  for (const tier of TIERS) {
    await channel.assertQueue(QUEUES[tier], { durable: false });
    await channel.bindQueue(QUEUES[tier], EXCHANGE, tier); // binding key = tier
  }
}
