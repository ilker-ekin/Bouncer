# Bouncer

A small API gateway that sits in front of a backend service and enforces
**per-tenant, tier-based rate limiting** using Redis. Allowed requests are
proxied to the backend; requests over the limit get a `429`.

This is a portfolio/learning project — the goal is to demonstrate rate limiting,
backpressure, and the reasoning behind each choice, cleanly and correctly.

> **Status:** v1 (Redis rate limiting) complete. v2 (RabbitMQ tiered
> prioritization) not started yet.

## How it works

Every request flows through three steps:

```
client ──▶ authenticate ──▶ rate limit ──▶ forward ──▶ backend
             (API key)     (token bucket,   (proxy)
                            atomic in Redis)
```

1. **authenticate** — reads `Authorization: Bearer <api-key>`, resolves it to a
   tenant + tier server-side. Unknown/missing key → `401`.
2. **rate limit** — a per-tenant [token bucket](#why-a-token-bucket) evaluated
   atomically in Redis. Under the limit → continue; empty bucket → `429`.
3. **forward** — proxies the request to the backend and relays the response.

`GET /health` is public (no key, no limiting). Everything else is gated.

## Tiers

Each tenant belongs to a tier that sets its token-bucket limits
(`rate` = sustained requests/sec, `capacity` = burst ceiling = 2× rate):

| Tier | Rate (req/s) | Capacity (burst) |
|------|--------------|------------------|
| T1   | 10           | 20               |
| T2   | 50           | 100              |
| T3   | 200          | 400              |

Tiers, limits, and the demo API keys live in [`src/config.ts`](src/config.ts).
For v1 they are a hardcoded in-memory table (no database, no auth system).

Demo keys: `key_t1_demo`, `key_t2_demo`, `key_t3_demo`.

## Running it

### Option A — Docker Compose (integrated, prod-like)

Runs Bouncer + Redis + a stub backend (`traefik/whoami`) together:

```bash
docker compose up --build
```

Then:

```bash
curl localhost:3000/health
curl -H "Authorization: Bearer key_t3_demo" localhost:3000/anything
```

### Option B — host dev (hot reload)

Run Redis and a backend in containers, and Bouncer on the host with reload:

```bash
docker run -d --name bouncer-redis  -p 6379:6379 redis:7-alpine
docker run -d --name bouncer-whoami -p 8080:80  traefik/whoami
npm install
npm run dev
```

Bouncer defaults to `redis://localhost:6379` and `http://localhost:8080` when
run outside Compose.

## Load test

Proves the per-tier limits hold. Fires a concurrent burst per tier and tallies
allowed (`200`) vs rejected (`429`):

```bash
npm run loadtest
```

Example output:

```
T1: sent  50 | 200= 20 | 429= 30 | capacity= 20
T2: sent 250 | 200=105 | 429=145 | capacity=100
T3: sent 1000 | 200=435 | 429=565 | capacity=400
```

Allowed counts land at each tier's capacity. A small overshoot is expected — the
bucket refills during the burst, so observed allowance ≈ `capacity + rate ×
burst_duration`. It scales with rate (T3 refills fastest → most overshoot),
which confirms the lazy refill is live.

## Configuration

| Variable      | Default                  | Purpose                        |
|---------------|--------------------------|--------------------------------|
| `PORT`        | `3000`                   | Bouncer listen port            |
| `REDIS_URL`   | `redis://localhost:6379` | Redis address                  |
| `BACKEND_URL` | `http://localhost:8080`  | Backend to proxy allowed traffic to |

None are secrets (just addresses). Compose sets `REDIS_URL`/`BACKEND_URL` to the
service network addresses.

## Design notes (the "why")

### Why a token bucket

Over a sliding-window log, token bucket stores just **two numbers per tenant**
(current tokens + last-refill timestamp) instead of one entry per request — O(1)
memory regardless of traffic. It also naturally allows a controlled **burst** up
to `capacity` after idle time, then settles to the steady `rate`, which is how
most real APIs behave. Refill is **lazy**: instead of a background timer, each
request computes `elapsed × rate` since the last touch and tops up (capped at
capacity).

### Why a Redis Lua script

The check is read → compute → write. Under concurrency, two requests can both
read "1 token left" before either writes, and both get allowed — the limit
leaks. Redis runs each *command* atomically but freely interleaves *sequences*
of commands from different clients. Running the whole read-compute-write as a
single [Lua script](src/ratelimit.ts) makes it one indivisible, atomic
operation — no race, and one round-trip (fast). Redis key: a hash
`ratelimit:<tenantId>` with fields `tokens` + `ts`, TTL `capacity / rate` so
idle tenants self-clean.

### Why fail open

If Redis becomes unreachable, the limiter **allows** requests rather than
rejecting them — availability over strict enforcement, so a limiter outage
doesn't take the backend down. `disableOfflineQueue` makes the Redis call reject
immediately when disconnected, so fail-open happens in ~milliseconds instead of
hanging on a reconnect.

## Scope

**In scope (v1):** per-tenant tier-based rate limiting on a single Redis
instance, request forwarding, run locally via Docker Compose.

**Not in scope:** distributed/multi-Redis limiting, per-endpoint or per-IP
limits, real auth/key management, streaming/websocket proxying, TLS termination.

## Roadmap

- **v1 — Redis rate limiting** ✅
- **v2 — RabbitMQ tiered prioritization** (queue + serve T3 before T1 under overload)
- **CI** — automated Redis + RabbitMQ integration tests
- **CD** — deploy to AWS

## Project layout

```
src/
  index.ts      app wiring: Redis connect, routes, middleware chain
  config.ts     tiers, limits, API key -> tenant table
  auth.ts       API-key authentication middleware
  ratelimit.ts  token-bucket Lua script + rate-limit middleware
  forward.ts    proxy allowed requests to the backend
scripts/
  loadtest.ts   concurrent per-tier burst test
```
