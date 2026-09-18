import type { Request, Response, NextFunction } from "express";
import type { RedisClientType } from "redis";
import { TIER_LIMITS } from "./config";

// Token-bucket check, run atomically inside Redis so concurrent requests can't
// race past the limit (read-compute-write is one indivisible unit).
//
// KEYS[1] = ratelimit:<tenantId>
// ARGV[1] = rate (tokens/sec), ARGV[2] = capacity, ARGV[3] = now (epoch ms)
// returns { allowed (0|1), tokensLeft (string) }
const TOKEN_BUCKET_SCRIPT = `
local key      = KEYS[1]
local rate     = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])

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

// Middleware factory: needs the connected Redis client. Runs after authenticate,
// so req.tenant is guaranteed set.
export function rateLimit(redis: RedisClientType) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenant = req.tenant;
    if (!tenant) {
      // Should never happen: authenticate runs first. Fail closed.
      return res.status(401).json({ error: "missing_api_key" });
    }

    const { rate, capacity } = TIER_LIMITS[tenant.tier];

    let result: [number, string];
    try {
      result = (await redis.eval(TOKEN_BUCKET_SCRIPT, {
        keys: [`ratelimit:${tenant.tenantId}`],
        arguments: [String(rate), String(capacity), String(Date.now())],
      })) as [number, string];
    } catch (err) {
      // Fail open: if Redis is unreachable, allow the request rather than taking
      // the backend down with the limiter. Availability over strict enforcement.
      console.error("Rate limiter Redis error (failing open):", err);
      return next();
    }

    const [allowed, tokensLeftStr] = result;
    const remaining = Math.floor(Number(tokensLeftStr));

    res.setHeader("X-RateLimit-Limit", capacity);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, remaining));

    if (allowed === 1) {
      return next();
    }

    // Over the limit: tell the client how long until one token is available.
    res.setHeader("Retry-After", Math.ceil(1 / rate));
    return res.status(429).json({ error: "rate_limited" });
  };
}
