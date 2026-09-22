import express from "express";
import { createClient } from "redis";
import { connect } from "amqplib";
import { authenticate } from "./auth";
import { rateLimit } from "./ratelimit";
import { declareTopology } from "./queue";
import { createDispatch, startConsumer } from "./dispatch";
import { registry } from "./metrics";

// One long-lived Redis connection, reused for every request (not per-request).
// URL comes from env: Docker sets redis://redis:6379; defaults to localhost otherwise.
// disableOfflineQueue: reject commands immediately when disconnected instead of
// queuing them, so the rate limiter fails open fast (see ratelimit.ts) rather
// than hanging ~5s waiting for a reconnect.
const redis = createClient({
  url: process.env.REDIS_URL,
  disableOfflineQueue: true,
});

// node-redis emits 'error' on connection trouble (drops, reconnect failures).
// If no listener is attached, it surfaces as an uncaught exception — so always attach one.
redis.on("error", (err) => console.error("Redis client error:", err));

const app = express();

// Public health check — no API key required.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Public metrics endpoint for Prometheus to scrape (no key). In production this
// would be restricted to the internal network, not exposed to clients.
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});

const port = Number(process.env.PORT) || 3000;

// Connect to Redis and prove the link with PING before we start accepting HTTP.
// PING -> "PONG" is Redis's "are you there?" — no data involved.
await redis.connect();
const pong = await redis.ping();
console.log(`Redis connected: ${pong}`);

// Connect to RabbitMQ (v2): one long-lived TCP connection, then one channel
// (a virtual connection multiplexed over it), and declare the tier topology.
const rabbitUrl = process.env.RABBITMQ_URL ?? "amqp://bouncer:bouncer@localhost:5672";
const rabbit = await connect(rabbitUrl);
rabbit.on("error", (err) => console.error("RabbitMQ connection error:", err));
rabbit.on("close", () => console.warn("RabbitMQ connection closed"));
const channel = await rabbit.createChannel();
await declareTopology(channel);
console.log("RabbitMQ connected; topology declared");

// Start the priority worker: drains tier queues (T3->T2->T1), paced by the
// in-flight cap, and answers each held request by forwarding it.
startConsumer(channel);

// Everything except /health is gated: authenticate -> rate limit -> dispatch.
// dispatch forwards directly under normal load, or enqueues by tier under overload.
// Registered after the channel exists, since dispatch needs it to publish.
app.all("*", authenticate, rateLimit(redis), createDispatch(channel));

app.listen(port, () => {
  console.log(`Bouncer listening on :${port}`);
});
