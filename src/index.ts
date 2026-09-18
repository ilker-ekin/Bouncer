import express from "express";
import { createClient } from "redis";
import { authenticate } from "./auth";
import { rateLimit } from "./ratelimit";
import { forward } from "./forward";

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

// Everything else is gated: authenticate -> rate limit -> forward to backend.
// Acts as a real gateway (all paths/methods except /health).
app.all("*", authenticate, rateLimit(redis), forward);

const port = Number(process.env.PORT) || 3000;

// Connect to Redis and prove the link with PING before we start accepting HTTP.
// PING -> "PONG" is Redis's "are you there?" — no data involved.
await redis.connect();
const pong = await redis.ping();
console.log(`Redis connected: ${pong}`);

app.listen(port, () => {
  console.log(`Bouncer listening on :${port}`);
});
