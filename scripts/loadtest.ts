// Manual load test for v1: fire a concurrent burst per tier and tally the
// allow/reject split. Proves Redis enforces the per-tier token-bucket limit.
//
// Usage: npm run loadtest            (needs Bouncer + Redis + backend running)
//        BOUNCER_URL=... npm run loadtest
import { TIER_LIMITS, API_KEYS, type Tier } from "../src/config";

const BASE = process.env.BOUNCER_URL ?? "http://localhost:3000";

// One demo API key per tier (first match wins).
const keyByTier: Partial<Record<Tier, string>> = {};
for (const [key, tenant] of Object.entries(API_KEYS)) {
  keyByTier[tenant.tier] ??= key;
}

async function burst(tier: Tier, key: string) {
  const { capacity, rate } = TIER_LIMITS[tier];
  // Enough to overwhelm even a full bucket that refills a little mid-burst.
  const total = capacity * 2 + rate;

  const codes = await Promise.all(
    Array.from({ length: total }, () =>
      fetch(`${BASE}/loadtest`, {
        headers: { Authorization: `Bearer ${key}` },
      })
        .then((r) => r.status)
        .catch(() => 0),
    ),
  );

  const allowed = codes.filter((c) => c === 200).length;
  const limited = codes.filter((c) => c === 429).length;
  const other = total - allowed - limited;
  console.log(
    `${tier}: sent ${total} | 200=${allowed} | 429=${limited}` +
      (other ? ` | other=${other}` : "") +
      ` | capacity=${capacity}`,
  );
}

for (const tier of ["T1", "T2", "T3"] as Tier[]) {
  const key = keyByTier[tier];
  if (key) await burst(tier, key);
}
