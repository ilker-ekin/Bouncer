// Integration tests — run against a live Bouncer + Redis + RabbitMQ + backend
// stack (see docker-compose.yml). Locally: `docker compose up -d` then `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BOUNCER_URL ?? "http://localhost:3000";
const T3_KEY = "key_t3_demo";

// Read+discard the body so sockets are released between requests.
async function drain(r: Response) {
  await r.arrayBuffer();
}

test("GET /health is public and returns ok", async () => {
  const r = await fetch(`${BASE}/health`);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(body, { status: "ok" });
});

test("gated route without an API key -> 401", async () => {
  const r = await fetch(`${BASE}/anything`);
  await drain(r);
  assert.equal(r.status, 401);
});

test("gated route with an unknown API key -> 401", async () => {
  const r = await fetch(`${BASE}/anything`, {
    headers: { Authorization: "Bearer not-a-real-key" },
  });
  await drain(r);
  assert.equal(r.status, 401);
});

test("gated route with a valid API key -> forwarded to backend (200)", async () => {
  const r = await fetch(`${BASE}/anything`, {
    headers: { Authorization: `Bearer ${T3_KEY}` },
  });
  await drain(r);
  assert.equal(r.status, 200);
});
