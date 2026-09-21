# Bouncer

A small API gateway that sits in front of a backend service. It (1) enforces
**per-tenant, tier-based rate limiting** using Redis, and (2) under backend
overload, queues requests and serves higher tiers first using RabbitMQ. Allowed
requests are proxied to the backend; requests over the limit get a `429`.

This is a portfolio/learning project — the goal is to demonstrate rate limiting,
backpressure, and the reasoning behind each choice, cleanly and correctly.

> **Status:** v1 (Redis rate limiting) complete. v2 (RabbitMQ tiered
> prioritization) in progress — RabbitMQ connection, queue topology, and
> overload detection are in place; request queuing/priority serving is not yet
> wired end-to-end.

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

Runs Bouncer + Redis + RabbitMQ + a stub backend (`mccutchen/go-httpbin`)
together, with `MAX_IN_FLIGHT=10` so the overload/priority behavior is visible:

```bash
docker compose up --build
```

RabbitMQ's management UI is at http://localhost:15672 (login `bouncer`/`bouncer`) —
handy for watching queues and messages.

Then:

```bash
curl localhost:3000/health
curl -H "Authorization: Bearer key_t3_demo" localhost:3000/anything   # echoes the request
curl -H "Authorization: Bearer key_t3_demo" localhost:3000/delay/1     # slow (drives the demo)
```

### Option B — host dev (hot reload)

Run Redis, RabbitMQ, and a backend in containers, and Bouncer on the host with reload:

```bash
docker run -d --name bouncer-redis   -p 6379:6379  redis:7-alpine
docker run -d --name bouncer-backend -p 8080:8080  mccutchen/go-httpbin
docker run -d --name bouncer-rabbit  -p 5672:5672 -p 15672:15672 \
  -e RABBITMQ_DEFAULT_USER=bouncer -e RABBITMQ_DEFAULT_PASS=bouncer \
  rabbitmq:3-management
npm install
MAX_IN_FLIGHT=10 npm run dev
```

Bouncer defaults to `redis://localhost:6379`, `http://localhost:8080`, and
`amqp://bouncer:bouncer@localhost:5672` when run outside Compose. It connects to
all three on startup and exits if any is unreachable.

> If RabbitMQ fails to start with `.erlang.cookie: eacces`, a stale anonymous
> volume has bad permissions — clear it with `docker volume prune -f`.

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

## Overload / priority demo (v2)

Proves that under backend overload, the **T3 backlog is served before T1**. It
saturates the backend with filler requests (so the measured burst all queues),
then fires an equal T1 + T3 burst at the slow `/delay/1` endpoint and compares
completion times:

```bash
npm run demo
```

Example output:

```
tier   ok/total    min    avg    max   (ms to complete)
T3   15/15       3056   3410   4114
T1   15/15       4116   4823   5179
✓ Priority holds: the T3 backlog drained before T1 (avg 3410ms vs 4823ms).
```

Here every T3 finished before any T1 (`T3 max 4114 < T1 min 4116`) — the whole T3
backlog drained first. Requires the low-cap slow-backend setup above
(`docker compose up`, or host dev with `MAX_IN_FLIGHT=10` + go-httpbin).

## Tests & CI

Integration tests (`node:test`, zero-dependency) run against the live stack —
health, auth, Redis rate limiting, and RabbitMQ overload priority:

```bash
docker compose up -d --build   # start the stack
npm test                       # run the suite against it
```

Or run the whole pipeline (boot → wait for /health → test → tear down) in one
command, mirroring CI exactly:

```bash
npm run ci:local
```

**CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs that same
pipeline on GitHub Actions — on every pull request targeting `main` (from any
branch), on pushes to `main`, and on manual dispatch. To block merges until it's
green, enable branch protection on `main` requiring the `CI` check.

## Configuration

| Variable        | Default                             | Purpose                        |
|-----------------|-------------------------------------|--------------------------------|
| `PORT`          | `3000`                              | Bouncer listen port            |
| `REDIS_URL`     | `redis://localhost:6379`            | Redis address                  |
| `BACKEND_URL`   | `http://localhost:8080`             | Backend to proxy allowed traffic to |
| `RABBITMQ_URL`  | `amqp://bouncer:bouncer@localhost:5672` | RabbitMQ address           |
| `MAX_IN_FLIGHT` | `50`                                | Concurrent backend requests before overload (queue kicks in) |

Compose sets these to the service network addresses (and `MAX_IN_FLIGHT=10`). The
RabbitMQ credentials are throwaway **dev** values — production credentials would
come from env/secrets, never committed.

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

### Why in-flight count for overload (v2)

Overload is detected by the number of requests currently in flight at the backend
exceeding a cap (`MAX_IN_FLIGHT`) — a simple, clear proxy for backend health,
chosen over rolling latency tracking. Beyond the cap, requests are queued instead
of forwarded directly.

### Why one queue per tier (v2)

A direct exchange (`requests`) routes each request to its tier's queue
(`requests.T1/T2/T3`) by routing key = tier; the worker drains T3 fully, then T2,
then T1. This gives **deterministic** priority rather than RabbitMQ's best-effort
priority-queue feature (whose ordering gets fuzzy with prefetch). Queues are
**transient** — a queued message represents an in-flight request with a client
waiting on an open connection, so there's nothing worth persisting across a broker
restart. Trade-off: T1 can starve under sustained T3 load (intended strict priority).

### How a queued response reaches the client (v2)

**In-process consumer + in-memory correlation map.** Bouncer publishes and consumes
in the same process: on enqueue it stores `{req, res}` in a map keyed by a request
id, publishes the id, and holds the HTTP connection open; the consumer looks up the
entry, forwards, and writes the response to the held `res`. No serialization needed
(single process). Scaling path if ever needed: a reply-queue RPC pattern so any
instance can serve the reply.

## Scope

**In scope (v1 + v2):** per-tenant tier-based rate limiting on a single Redis
instance, request forwarding, tier-based priority queuing under overload via
RabbitMQ, run locally via Docker Compose.

**Not in scope:** distributed/multi-Redis limiting, multi-instance Bouncer,
per-endpoint or per-IP limits, real auth/key management, streaming/websocket
proxying, TLS termination.

## Roadmap

- **v1 — Redis rate limiting** ✅
- **v2 — RabbitMQ tiered prioritization** ✅ (overload detection, publish, and a
  priority consumer that drains T3→T2→T1; proven with `npm run demo`)
- **CI** — GitHub Actions running the Redis + RabbitMQ integration tests ✅
- **CD** — deploy to AWS
- **v3 (candidate)** — `/metrics` endpoint + Prometheus/Grafana observability

## Project layout

```
src/
  index.ts      app wiring: Redis + RabbitMQ connect, topology, routes, chain
  config.ts     tiers, limits, API key -> tenant table
  auth.ts       API-key authentication middleware
  ratelimit.ts  token-bucket Lua script + rate-limit middleware
  overload.ts   in-flight counter + MAX_IN_FLIGHT cap (overload detection)
  queue.ts      RabbitMQ topology: direct exchange + per-tier queues
  dispatch.ts   fork: forward directly, or enqueue + priority consumer (v2)
  forward.ts    proxy a request to the backend
scripts/
  loadtest.ts       concurrent per-tier burst (rate-limit proof)
  demo-overload.ts  overload/priority demo (T3 served before T1)
  ci-local.sh       run the CI pipeline locally (boot -> test -> teardown)
tests/
  integration.test.ts  health + auth
  ratelimit.test.ts    Redis rate limiting (429 + headers)
  overload.test.ts     RabbitMQ overload priority (T3 before T1)
  helpers.ts           shared test helpers
.github/workflows/
  ci.yml            GitHub Actions: boot stack, run tests, tear down
```
