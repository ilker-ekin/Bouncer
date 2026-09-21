// Redis rate-limiting integration test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, TENANT, flushTenantBucket } from "./helpers";

const T1_KEY = "key_t1_demo";

test("T1 burst beyond capacity -> 429s with rate-limit headers", async () => {
  await flushTenantBucket(TENANT.T1); // start from a full bucket (capacity 20)

  const N = 30;
  const responses = await Promise.all(
    Array.from({ length: N }, () =>
      fetch(`${BASE}/anything`, { headers: { Authorization: `Bearer ${T1_KEY}` } }),
    ),
  );
  await Promise.all(responses.map((r) => r.arrayBuffer())); // drain bodies

  const s200 = responses.filter((r) => r.status === 200).length;
  const s429 = responses.filter((r) => r.status === 429).length;

  assert.equal(s200 + s429, N, "every response is 200 or 429");
  assert.ok(s429 > 0, `expected some 429s, got ${s429}`);
  assert.ok(s200 <= 25, `expected ~capacity allowed, got ${s200}`);

  const limited = responses.find((r) => r.status === 429);
  assert.ok(limited, "expected at least one 429 response");
  assert.ok(limited.headers.get("retry-after"), "429 carries Retry-After");
  assert.equal(limited.headers.get("x-ratelimit-limit"), "20");
  assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
});
