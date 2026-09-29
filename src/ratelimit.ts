import type { Request, Response, NextFunction } from "express";
import { defineScript } from "redis";
import { TIER_LIMITS } from "./config.js";
import { recordRequest } from "./metrics.js";

// Token-bucket check, run atomically inside Redis so concurrent requests can't
// race past the limit (read-compute-write is one indivisible unit).
//
// The clock is Redis's own (TIME), not the gateway's: every gateway instance
// then refills against the same clock, so skew between gateway hosts can't
// mint or swallow tokens. TIME before writes is fine on Redis >= 5 (scripts
// replicate their effects, not the script itself).
//
// KEYS[1] = ratelimit:<tenantId>
// ARGV[1] = rate (tokens/sec), ARGV[2] = capacity
// returns { allowed (0|1), tokensLeft (string) }
const TOKEN_BUCKET_SCRIPT = `
local key      = KEYS[1]
local rate     = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])

-- Redis server time as epoch ms: TIME returns { seconds, microseconds }.
local t        = redis.call("TIME")
local now      = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

-- Read current state; default to a full bucket on first-ever request.
local data     = redis.call("HMGET", key, "tokens", "ts")
local tokens   = tonumber(data[1]) or capacity
local ts       = tonumber(data[2]) or now

-- Lazy refill: add tokens for the time elapsed, capped at capacity.
local elapsed  = math.max(0, now - ts) / 1000
tokens         = math.min(capacity, tokens + elapsed * rate)

-- Decide.
local allowed  = 0
if tokens >= 1 then
  allowed = 1
  tokens  = tokens - 1
end

-- Persist new state + refresh TTL so idle tenants self-clean.
redis.call("HSET", key, "tokens", tokens, "ts", now)
redis.call("EXPIRE", key, math.ceil(capacity / rate))

return { allowed, tostring(tokens) }
`;

// Registered on the client (see index.ts) as `redis.tokenBucket(...)`.
// node-redis sends EVALSHA with the script's SHA1 and only falls back to EVAL
// (which also caches it server-side) on NOSCRIPT — e.g. the first call, or
// after a Redis restart / SCRIPT FLUSH. So the source isn't resent per request.
export const tokenBucket = defineScript({
  SCRIPT: TOKEN_BUCKET_SCRIPT,
  NUMBER_OF_KEYS: 1,
  parseCommand(parser, key: string, rate: number, capacity: number) {
    parser.pushKey(key);
    parser.push(String(rate), String(capacity));
  },
  // Lua returns { 0|1, "<tokens>" } (a string so fractional tokens survive
  // Redis's float -> integer truncation of Lua numbers).
  transformReply: (reply: [number, string]): TokenBucketResult => ({
    allowed: reply[0] === 1,
    tokensLeft: Number(reply[1]),
  }),
});

type TokenBucketResult = { allowed: boolean; tokensLeft: number };

// The only Redis capability the middleware needs.
type TokenBucketClient = {
  tokenBucket(key: string, rate: number, capacity: number): Promise<TokenBucketResult>;
};

// Middleware factory: needs the connected Redis client. Runs after authenticate,
// so req.tenant is guaranteed set.
export function rateLimit(redis: TokenBucketClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenant = req.tenant;
    if (!tenant) {
      // Should never happen: authenticate runs first. Fail closed.
      return res.status(401).json({ error: "missing_api_key" });
    }

    const { rate, capacity } = TIER_LIMITS[tenant.tier];

    let result: TokenBucketResult;
    try {
      result = await redis.tokenBucket(`ratelimit:${tenant.tenantId}`, rate, capacity);
    } catch (err) {
      // Fail open: if Redis is unreachable, allow the request rather than taking
      // the backend down with the limiter. Availability over strict enforcement.
      console.error("Rate limiter Redis error (failing open):", err);
      return next();
    }

    const remaining = Math.floor(result.tokensLeft);

    res.setHeader("X-RateLimit-Limit", capacity);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, remaining));

    if (result.allowed) {
      return next();
    }

    // Over the limit: tell the client how long until one token is available.
    recordRequest(tenant.tier, "rate_limited");
    res.setHeader("Retry-After", Math.ceil(1 / rate));
    return res.status(429).json({ error: "rate_limited" });
  };
}
