// Load-shedding integration tests: under backend overload, a full tier queue
// and an over-long queue wait both answer 503 + Retry-After. Requires the
// docker-compose.test.yml overrides (MAX_QUEUE_LENGTH_T2=5) on top of the base
// stack (MAX_IN_FLIGHT=10, default MAX_QUEUE_WAIT_MS=5000). T2 is used here so
// the T1/T3 priority test keeps its own queues.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, TENANT, flushTenantBucket, requestCount, sleep, timedRequest } from "./helpers";

const T2_KEY = "key_t2_demo";
const T3_KEY = "key_t3_demo";
const CAP = 10; // MAX_IN_FLIGHT in docker-compose.yml
const T2_QUEUE = 5; // MAX_QUEUE_LENGTH_T2 in docker-compose.test.yml
const WAIT_MS = 5000; // MAX_QUEUE_WAIT_MS default

// Occupy every backend slot for `seconds` so new requests must queue.
function saturate(seconds: number): Promise<unknown> {
  return Promise.all(
    Array.from({ length: CAP }, () =>
      fetch(`${BASE}/delay/${seconds}`, {
        headers: { Authorization: `Bearer ${T3_KEY}` },
      }).then((r) => r.arrayBuffer()),
    ),
  );
}

test("overloaded tier queue at capacity -> 503 + Retry-After", { timeout: 30_000 }, async () => {
  await flushTenantBucket(TENANT.T2);
  await flushTenantBucket(TENANT.T3);
  const shedBefore = await requestCount("T2", "shed");

  const filler = saturate(2);
  await sleep(300);

  // 3 more than the queue holds: exactly T2_QUEUE wait, the rest are shed.
  const start = Date.now();
  const responses = await Promise.all(
    Array.from({ length: T2_QUEUE + 3 }, () =>
      fetch(`${BASE}/anything`, { headers: { Authorization: `Bearer ${T2_KEY}` } }).then(
        async (r) => ({
          status: r.status,
          retryAfter: r.headers.get("retry-after"),
          body: await r.json(),
          ms: Date.now() - start,
        }),
      ),
    ),
  );
  await filler;

  const shed = responses.filter((r) => r.status === 503);
  const served = responses.filter((r) => r.status === 200);
  assert.equal(served.length, T2_QUEUE, "the queued requests are served once slots free");
  assert.equal(shed.length, 3, "requests beyond the queue length are shed");
  for (const r of shed) {
    assert.deepEqual(r.body, { error: "queue_full" });
    assert.ok(Number(r.retryAfter) > 0, "503 carries Retry-After");
    assert.ok(r.ms < 1000, `shed at admission, not after waiting (${r.ms}ms)`);
  }
  assert.equal((await requestCount("T2", "shed")) - shedBefore, 3, "shed outcome counted");
});

test("queued request not served within MAX_QUEUE_WAIT_MS -> 503", { timeout: 30_000 }, async () => {
  await flushTenantBucket(TENANT.T2);
  await flushTenantBucket(TENANT.T3);
  const shedBefore = await requestCount("T2", "shed");

  // Slots stay busy longer than the wait timeout, so the request can't be served.
  const filler = saturate(Math.ceil(WAIT_MS / 1000) + 2);
  await sleep(300);

  const start = Date.now();
  const r = await fetch(`${BASE}/anything`, { headers: { Authorization: `Bearer ${T2_KEY}` } });
  const ms = Date.now() - start;
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "queue_timeout" });
  assert.ok(Number(r.headers.get("retry-after")) > 0, "503 carries Retry-After");
  assert.ok(ms >= WAIT_MS - 100 && ms < WAIT_MS + 1500, `timed out after ~${WAIT_MS}ms (${ms}ms)`);
  assert.equal((await requestCount("T2", "shed")) - shedBefore, 1, "shed outcome counted");

  // Still overloaded (filler runs ~2s longer). The timed-out request must have
  // freed its queue slot, so a full queue's worth of T2 is accepted, not shed.
  // Its id is still at the head of the T2 queue in RabbitMQ; when slots free,
  // the consumer must ack and skip it, then serve these.
  const after = await Promise.all(
    Array.from({ length: T2_QUEUE }, () => timedRequest("/anything", T2_KEY, Date.now())),
  );
  await filler;
  assert.deepEqual(
    after.map((x) => x.status),
    Array(T2_QUEUE).fill(200),
    "queue slot freed on timeout; stale id skipped",
  );
});
