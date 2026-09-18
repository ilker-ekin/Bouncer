export type Tier = "T1" | "T2" | "T3";

// Token-bucket parameters for a tier.
export type TierLimit = {
  rate: number; // tokens (requests) refilled per second — the sustained limit
  capacity: number; // max tokens the bucket holds — the burst ceiling
};

// What an API key resolves to.
export type Tenant = {
  tenantId: string;
  tier: Tier;
};

// Per-tier limits (10/50/200 req/s, capacity = 2x rate).
// Record<Tier, ...> forces exactly T1/T2/T3 — a missing or typo'd tier won't compile.
export const TIER_LIMITS: Record<Tier, TierLimit> = {
  T1: { rate: 10, capacity: 20 },
  T2: { rate: 50, capacity: 100 },
  T3: { rate: 200, capacity: 400 },
};

// API key -> tenant. Hardcoded for v1: no DB, no auth, no hashing. Keys are demo values.
export const API_KEYS: Record<string, Tenant> = {
  key_t1_demo: { tenantId: "acme", tier: "T1" },
  key_t2_demo: { tenantId: "globex", tier: "T2" },
  key_t3_demo: { tenantId: "initech", tier: "T3" },
};
