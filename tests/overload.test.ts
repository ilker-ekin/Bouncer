// RabbitMQ overload/priority integration test: under backend overload, the T3
// backlog is served before T1. Requires a slow backend + low MAX_IN_FLIGHT
// (the docker-compose stack sets go-httpbin + MAX_IN_FLIGHT=10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, TENANT, flushTenantBucket, sleep, timedRequest } from "./helpers";

const T1_KEY = "key_t1_demo";
const T3_KEY = "key_t3_demo";

test(
  "under overload, the T3 backlog is served before T1",
  { timeout: 30_000 },
  async () => {
    await flushTenantBucket(TENANT.T1);
    await flushTenantBucket(TENANT.T3);

    const start = Date.now();

    // Saturate the backend (cap=10) with slow filler so the measured burst queues.
    const filler = Array.from({ length: 10 }, () =>
      fetch(`${BASE}/delay/2`, {
        headers: { Authorization: `Bearer ${T3_KEY}` },
      }).then((r) => r.arrayBuffer()),
    );
    await sleep(300);

    // Measured burst — all queue behind the filler. N < T1 capacity (20) so v1
    // rate limiting doesn't interfere.
    const N = 15;
    const t1 = Array.from({ length: N }, () => timedRequest("/delay/1", T1_KEY, start));
    const t3 = Array.from({ length: N }, () => timedRequest("/delay/1", T3_KEY, start));
    const [t1res, t3res] = await Promise.all([Promise.all(t1), Promise.all(t3)]);
    await Promise.all(filler);

    assert.ok(t1res.every((r) => r.status === 200), "all measured T1 -> 200");
    assert.ok(t3res.every((r) => r.status === 200), "all measured T3 -> 200");

    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const t3avg = avg(t3res.map((r) => r.ms));
    const t1avg = avg(t1res.map((r) => r.ms));
    assert.ok(
      t3avg < t1avg,
      `T3 backlog should drain first: T3 avg ${Math.round(t3avg)}ms < T1 avg ${Math.round(t1avg)}ms`,
    );
  },
);
