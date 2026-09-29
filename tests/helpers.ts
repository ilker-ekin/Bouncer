import { createClient } from "redis";

export const BASE = process.env.BOUNCER_URL ?? "http://localhost:3000";

// Tenant ids behind the demo keys (see src/config.ts).
export const TENANT = { T1: "acme", T2: "globex", T3: "initech" } as const;

// Reset a tenant's token bucket so a rate-limit test starts from a full bucket.
export async function flushTenantBucket(tenantId: string): Promise<void> {
  const redis = createClient({ url: process.env.REDIS_URL });
  await redis.connect();
  await redis.del(`ratelimit:${tenantId}`);
  await redis.quit();
}

// Current value of a bouncer_requests_total series from /metrics (0 if absent).
export async function requestCount(tier: string, outcome: string): Promise<number> {
  const text = await (await fetch(`${BASE}/metrics`)).text();
  const line = text
    .split("\n")
    .find((l) => l.startsWith(`bouncer_requests_total{tier="${tier}",outcome="${outcome}"}`));
  return line ? Number(line.split(" ").pop()) : 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Fire a request and return when it fully completes, with elapsed ms + status.
export async function timedRequest(
  path: string,
  key: string,
  start: number,
): Promise<{ ms: number; status: number }> {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const status = r.status;
  await r.arrayBuffer(); // drain the body so the request fully completes
  return { ms: Date.now() - start, status };
}
