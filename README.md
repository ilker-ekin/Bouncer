# Bouncer

[![CI](https://github.com/ilker-ekin/Bouncer/actions/workflows/ci.yml/badge.svg)](https://github.com/ilker-ekin/Bouncer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/Node-22-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

An API gateway that sits in front of a backend service and:

1. **Rate limits** each tenant with a **per-tier token bucket** in Redis (allowed → proxied; over the limit → `429`).
2. Under backend **overload**, **queues** requests and serves **higher tiers first** using RabbitMQ.

> **Portfolio / learning project.** The goal is to demonstrate rate limiting,
> backpressure, and tiered prioritization — cleanly and correctly, with the
> reasoning behind each decision documented (see [Design notes](#design-notes-the-why)).

**Status:** v1 (Redis rate limiting) ✅ · v2 (RabbitMQ tiered prioritization) ✅ · CI ✅ · Monitoring (Prometheus + Grafana) ✅ · Production hardening (compiled non-root image, Redis-clock token bucket, load shedding) ✅ · CD (AWS) planned.

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Usage](#usage)
- [Tiers](#tiers)
- [Load test & overload demo](#load-test--overload-demo)
- [Tests & CI](#tests--ci)
- [Monitoring](#monitoring)
- [Configuration](#configuration)
- [Design notes (the "why")](#design-notes-the-why)
- [Trade-offs & limitations](#trade-offs--limitations)
- [Project structure](#project-structure)
- [Roadmap](#roadmap)
- [Scope](#scope)
- [License](#license)

## Features

- **Per-tenant, tier-based rate limiting** — token bucket evaluated **atomically** in Redis via a Lua script (no race conditions).
- **API-key auth** — identity + tier resolved server-side; never client-declared.
- **Reverse proxy** — forwards allowed requests to a backend, with body-size limits, backend timeouts, and hop-by-hop header hygiene.
- **Tiered prioritization under overload** — requests beyond a concurrency cap are queued in RabbitMQ and drained **T3 → T2 → T1**.
- **Load shedding** — bounded per-tier queues and a max queue wait; excess overload traffic gets a fast `503` + `Retry-After`.
- **Fail-open** — if Redis is unreachable, requests are allowed rather than dropped (availability over strict enforcement).
- **Fully containerized** — one `docker compose up` brings up the gateway, Redis, RabbitMQ, a backend, Prometheus, and Grafana.
- **Integration-tested in CI** — GitHub Actions runs the suite against the real stack on every PR.
- **Observability** — Prometheus metrics (`/metrics`) + a provisioned Grafana dashboard (request rates, 429s, in-flight, queue depth, p95 latency).

## How it works

Every request flows through a middleware chain. `GET /health` is public; everything else is gated.

```
                    ┌──────────── normal load ────────────┐
client ─▶ authenticate ─▶ rate limit ─▶ dispatch ─▶ forward ─▶ backend
          (API key)     (token bucket,     │        (proxy)
                         atomic in Redis)   │
                                            └── overloaded ──▶ RabbitMQ tier queue
                                                              (T3│T2│T1) ─▶ worker
                                                              drains T3→T2→T1 ─▶ backend
```

1. **authenticate** — reads `Authorization: Bearer <api-key>`, resolves it to a tenant + tier server-side. Unknown/missing key → `401`.
2. **rate limit** — a per-tenant [token bucket](#why-a-token-bucket) evaluated atomically in Redis. Under the limit → continue; empty bucket → `429` (with `Retry-After` + `X-RateLimit-*`).
3. **dispatch** — if the backend has capacity, **forward** directly; if it's [overloaded](#why-in-flight-count-for-overload), **enqueue** by tier and hold the connection open.
4. **worker** — drains the tier queues in priority order and forwards each held request, answering the waiting client.
5. **load shedding** — a tier's queue is bounded (`MAX_QUEUE_LENGTH`), and a held request waits at most `MAX_QUEUE_WAIT_MS`; either limit answers `503` + `Retry-After` instead of holding the connection indefinitely.

## Tech stack

| Concern | Choice |
|---------|--------|
| Language / runtime | TypeScript (strict) on Node 22 — `tsx` in dev, compiled with `tsc` to `dist/` for the image |
| HTTP | Express |
| Rate limiting | Redis + Lua (`node-redis`) |
| Prioritization | RabbitMQ (`amqplib`) |
| Tests | `node:test` (zero-dependency) |
| Metrics | `@prometheus-io/client` → Prometheus → Grafana |
| Orchestration | Docker Compose |
| CI | GitHub Actions |

## Getting started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (with Compose)
- [Node.js 22+](https://nodejs.org/) (only for running tests / scripts on the host)

### Quick start (Docker Compose)

Brings up Bouncer + Redis + RabbitMQ + a stub backend (`mccutchen/go-httpbin`),
with `MAX_IN_FLIGHT=10` so the overload/priority behavior is visible:

```bash
docker compose up --build
```

RabbitMQ's management UI is at http://localhost:15672 (login `bouncer` / `bouncer`).

### Host dev (hot reload)

Run the dependencies in containers and Bouncer on the host with reload:

```bash
docker run -d --name bouncer-redis   -p 6379:6379  redis:7-alpine
docker run -d --name bouncer-backend -p 8080:8080  mccutchen/go-httpbin
docker run -d --name bouncer-rabbit  -p 5672:5672 -p 15672:15672 \
  -e RABBITMQ_DEFAULT_USER=bouncer -e RABBITMQ_DEFAULT_PASS=bouncer \
  rabbitmq:3-management
npm install
MAX_IN_FLIGHT=10 npm run dev
```

Bouncer connects to Redis, RabbitMQ, and the backend on startup and exits if any
is unreachable. Outside Compose it defaults to `localhost` for all three.

> If RabbitMQ fails to start with `.erlang.cookie: eacces`, a stale anonymous
> volume has bad permissions — clear it with `docker volume prune -f`.

## Usage

```bash
curl localhost:3000/health                                            # public -> {"status":"ok"}
curl -H "Authorization: Bearer key_t3_demo" localhost:3000/anything   # forwarded (echoes the request)
curl -H "Authorization: Bearer key_t3_demo" localhost:3000/delay/1    # slow backend path (drives the demo)
curl localhost:3000/anything                                          # no key -> 401
```

## Tiers

Each tenant belongs to a tier that sets its token-bucket limits
(`rate` = sustained requests/sec, `capacity` = burst ceiling = 2× rate):

| Tier | Rate (req/s) | Capacity (burst) |
|------|--------------|------------------|
| T1   | 10           | 20               |
| T2   | 50           | 100              |
| T3   | 200          | 400              |

Tiers, limits, and the demo API keys live in [`src/config.ts`](src/config.ts) —
a hardcoded in-memory table for now (no database, no auth system).
Demo keys: `key_t1_demo`, `key_t2_demo`, `key_t3_demo`.

## Load test & overload demo

**Rate-limit load test** — fires a concurrent burst per tier and tallies allowed (`200`) vs rejected (`429`):

```bash
npm run loadtest
```

```
T1: sent  50 | 200= 20 | 429= 30 | capacity= 20
T2: sent 250 | 200=105 | 429=145 | capacity=100
T3: sent 1000 | 200=435 | 429=565 | capacity=400
```

Allowed counts land at each tier's capacity. The small overshoot ≈ `rate ×
burst_duration` — the bucket refilling mid-burst, which confirms the lazy refill
is live.

**Overload / priority demo** — saturates the backend, then shows the T3 backlog draining before T1:

```bash
npm run demo
```

```
tier   ok/total    min    avg    max   (ms to complete)
T3   15/15       3056   3410   4114
T1   15/15       4116   4823   5179
✓ Priority holds: the T3 backlog drained before T1 (avg 3410ms vs 4823ms).
```

Every T3 finished before any T1 (`T3 max 4114 < T1 min 4116`).

## Tests & CI

Integration tests (`node:test`, zero-dependency) run against the live stack —
health, auth, Redis rate limiting, RabbitMQ overload priority, and load
shedding (queue full / wait timeout → `503`). The tests layer
[`docker-compose.test.yml`](docker-compose.test.yml) on top of the base stack
(a tiny T2 queue, so "queue full" takes a handful of requests):

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build
npm test
```

Or run the whole pipeline (boot → wait for `/health` → test → tear down) in one
command, mirroring CI exactly:

```bash
npm run ci:local
```

The pipeline typechecks (`tsc --noEmit`), builds the production image, boots the
stack, and runs the tests.
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs it on
GitHub Actions — on every pull request targeting `main` (from any branch), on
pushes to `main`, and on manual dispatch. Enable branch protection requiring the
`CI` check to gate merges.

## Monitoring

`docker compose up` also starts **Prometheus** and **Grafana**. Bouncer exposes
metrics at **`/metrics`**; Prometheus scrapes them; Grafana renders a dashboard —
all provisioned as code (no manual setup).

| Service | URL | Notes |
|---------|-----|-------|
| Metrics endpoint | http://localhost:3000/metrics | Prometheus exposition format |
| Prometheus | http://localhost:9090 | query/debug UI; `/targets` shows scrape health |
| Grafana | http://localhost:3001/d/bouncer/bouncer | **Bouncer** dashboard (anonymous access, dev-only) |

**Metrics exposed:**

| Metric | Type | Labels |
|--------|------|--------|
| `bouncer_requests_total` | counter | `tier`, `outcome` (`forwarded`/`queued`/`rate_limited`/`unauthorized`/`shed`) |
| `bouncer_in_flight` | gauge | — |
| `bouncer_backend_duration_seconds` | histogram | `tier` |

`shed` counts every load-shedding `503` (queue full, or wait timeout). A request
that waited and then timed out was already counted as `queued`, so it appears
under both.

Plus default Node process metrics (CPU, memory, event-loop lag).

**See it move** — open the Grafana dashboard, then in another terminal:

```bash
npm run demo       # In-flight pins at the cap; Queued spikes for T1+T3; T1 p95 climbs
npm run loadtest   # the 429/s-by-tier panel lights up
```

The dashboard shows request rate (by outcome and tier), 429s by tier, live
in-flight concurrency, queued and shed rates by tier, and **p95 backend latency by tier** —
which visually demonstrates the tier prioritization (T3 stays fast; T1 degrades
because it's served last under overload).

> `/metrics` and Grafana are unauthenticated here for convenience; in production
> you'd restrict `/metrics` to the internal network and secure Grafana.

## Configuration

| Variable        | Default                                 | Purpose                                              |
|-----------------|-----------------------------------------|------------------------------------------------------|
| `PORT`          | `3000`                                  | Bouncer listen port                                  |
| `REDIS_URL`     | `redis://localhost:6379`                | Redis address                                        |
| `BACKEND_URL`   | `http://localhost:8080`                 | Backend to proxy allowed traffic to                  |
| `RABBITMQ_URL`  | `amqp://bouncer:bouncer@localhost:5672` | RabbitMQ address                                     |
| `MAX_IN_FLIGHT` | `50`                                    | Concurrent backend requests before overload (queuing) |
| `MAX_QUEUE_LENGTH` | `1000`                               | Max requests waiting per tier; beyond it → `503` (`queue_full`) |
| `MAX_QUEUE_LENGTH_T1/T2/T3` | `MAX_QUEUE_LENGTH`          | Per-tier override of the above                       |
| `MAX_QUEUE_WAIT_MS` | `5000`                              | Max time a request waits in the queue; then → `503` (`queue_timeout`) |

Compose sets these to the service network addresses (and `MAX_IN_FLIGHT=10`). The
RabbitMQ credentials are throwaway **dev** values — production credentials would
come from env/secrets, never committed.

## Design notes (the "why")

### Why a token bucket

Over a sliding-window log, a token bucket stores just **two numbers per tenant**
(current tokens + last-refill timestamp) instead of one entry per request — O(1)
memory regardless of traffic. It also allows a controlled **burst** up to
`capacity` after idle time, then settles to the steady `rate`. Refill is
**lazy**: each request computes `elapsed × rate` since the last touch and tops up
(capped at capacity) — no background timer.

### Why a Redis Lua script

The check is read → compute → write. Under concurrency, two requests can both
read "1 token left" before either writes, and both get allowed — the limit leaks.
Redis runs each *command* atomically but freely interleaves *sequences* from
different clients. Running the whole read-compute-write as a single
[Lua script](src/ratelimit.ts) makes it one indivisible, atomic operation — no
race, and one round-trip. Key: a hash `ratelimit:<tenantId>` with fields `tokens`
+ `ts`, TTL `capacity / rate` so idle tenants self-clean.

**The clock is Redis's, not the gateway's.** The script reads `now` with
`redis.call('TIME')` instead of taking `Date.now()` as an argument. Refill math
is `elapsed = now - ts`, so if two gateway hosts disagree about the time, a
request from the "behind" host sees negative elapsed (clamped to 0, so no
refill), and one from the "ahead" host mints tokens that were never earned.
With one clock that can't happen, whatever the gateway hosts' clocks say.
(Writing after `TIME` is allowed because Redis ≥ 5 replicates a script's
effects rather than re-running it on replicas.)

**The script is registered once, then called by hash.** It's defined with
node-redis `defineScript` and registered on the client, so each call is
`EVALSHA <sha1>` rather than resending the source. On `NOSCRIPT` (first call,
Redis restart, `SCRIPT FLUSH`) the client falls back to `EVAL` once, which also
re-caches it.

### Why fail open

If Redis becomes unreachable, the limiter **allows** requests rather than
rejecting them — availability over strict enforcement, so a limiter outage
doesn't take the backend down. `disableOfflineQueue` makes the Redis call reject
immediately when disconnected, so fail-open happens in ~milliseconds instead of
hanging on a reconnect.

### Why in-flight count for overload

Overload is detected by the number of requests currently in flight at the backend
exceeding `MAX_IN_FLIGHT` — a simple, clear proxy for backend health, chosen over
rolling latency tracking. Beyond the cap, requests are queued instead of forwarded
directly. (The counter is incremented synchronously at the decision point so a
simultaneous burst is actually gated.)

### Why one queue per tier

A direct exchange (`requests`) routes each request to its tier's queue
(`requests.T1/T2/T3`) by routing key = tier; the worker drains T3 fully, then T2,
then T1. This gives **deterministic** priority rather than RabbitMQ's best-effort
priority-queue feature (whose ordering gets fuzzy with prefetch). Queues are
**transient** — a queued message represents an in-flight request with a client
waiting on an open connection, so there's nothing worth persisting across a broker
restart. Trade-off: T1 can starve under sustained T3 load (intended strict priority).

### How a queued response reaches the client

**In-process consumer + in-memory correlation map.** Bouncer publishes and
consumes in the same process: on enqueue it stores `{req, res}` in a map keyed by
a request id, publishes the id, and holds the HTTP connection open; the consumer
looks up the entry, forwards, and writes the response to the held `res`. No
serialization (single process). Scaling path: a reply-queue RPC pattern so any
instance can serve the reply.

### Why shed load (and why the bound is in-process)

A queue only helps if it drains before clients give up. Every held request is an
open socket plus its `req`/`res` objects. Without limits, sustained overload
grows memory and latency until everything fails at once. Two limits turn that
into fast, explicit `503`s with `Retry-After`:

- **`MAX_QUEUE_LENGTH` per tier.** A full tier queue rejects new overload
  traffic at admission, so the rejection is fast.
- **`MAX_QUEUE_WAIT_MS`.** A held request not dequeued in time gets `503`
  and is removed from the map. Its id stays in RabbitMQ; when the consumer
  reaches it, it finds no entry, acks and skips it without using a backend slot.

The length bound is an **in-process counter** of live waiters, not RabbitMQ's
`x-max-length` + `reject-publish`. The broker would count ids for requests that
already timed out or disconnected until the consumer drained them, so the
bound would drift from what's actually held in memory. It would also need a
publisher-confirm round trip per enqueue. The correlation map already makes
this single-instance, so a local count is exact and costs nothing.
Each request leaves the queue exactly once (served, timed out, or client gone),
and its slot is released at that moment.

## Trade-offs & limitations

Deliberate choices, and what they cost.

**Single instance, by design.** The correlation map (`pending`), the in-flight
counter and the queue-length counters all live in the Bouncer process, and
RabbitMQ carries only request **ids**, which mean nothing to any other process.
If you ran two replicas against one broker, instance A's consumer could dequeue
B's id: A finds no entry, acks and drops it, and B's client waits until
`MAX_QUEUE_WAIT_MS` and gets a `503`. The rate limiter is the one piece that is
already multi-instance-safe (all state and the clock are in Redis). Scaling out
would need per-instance (exclusive) queues, or a reply-queue RPC that carries
the serialized request instead of an id.

**Strict priority can starve T1.** The consumer drains T3 completely, then T2,
then T1. Under *sustained* overload with enough T3/T2 traffic, T1 is never
dequeued. Load shedding bounds the damage (a starved T1 request now gets a
`503` after `MAX_QUEUE_WAIT_MS` instead of hanging), but T1 is still
starved. The next step would be **aging** (a request's effective priority rises
with its wait) or **weighted fair queuing** (e.g. dequeue T3:T2:T1 in a 6:3:1
ratio), which guarantees every tier a share of capacity. Neither is implemented.
Strict priority is the documented behaviour for now.

**Fail-open vs fail-closed, per dependency.**

- *Redis down → fail open.* The limiter lets requests through, so no tenant is
  rate limited during the outage. The backend is then protected only by
  `MAX_IN_FLIGHT` and the queue bounds. That is right when the limit protects
  capacity. It would be wrong if the limit enforced a paid quota or an abuse
  boundary; those should fail closed (`503`).
- *RabbitMQ down mid-run → overload traffic fails closed.* There is no
  reconnect logic. Requests under `MAX_IN_FLIGHT` are still forwarded directly,
  but publishing to a closed channel throws, so overload traffic gets a `500`.
  Requests already held get a `503` when their wait expires. The consumer loop
  logs and keeps retrying.
- *Startup* fails fast if Redis or RabbitMQ is unreachable, so a
  half-configured gateway never starts serving traffic.

**Polling consumer, not push.** The worker calls `basic.get` on T3, then T2,
then T1, and sleeps 10 ms when the queues are empty or the backend is full. This
makes priority exact and paces dequeues by `MAX_IN_FLIGHT` (it pulls only when a
slot is free). The cost is up to three round trips per dequeue, up to ~10 ms of
added latency, and a steady trickle of `basic.get` traffic while idle. A push
consumer (`basic.consume` + prefetch) avoids both, but prefetched messages sit
in the client, so a T1 message already delivered can be served ahead of a T3
that arrives later. Keeping strict priority with push would take prefetch = 1
per queue plus local reordering.

**RabbitMQ is more than one instance strictly needs.** For a single process, an
in-memory priority queue would do the same job. RabbitMQ is here because the
project set out to learn it, and because it is the natural place to grow if
Bouncer ever scales out (see above).

## Project structure

```
src/
  index.ts      app wiring: Redis + RabbitMQ connect, topology, routes, chain
  config.ts     tiers, limits, API key -> tenant table
  auth.ts       API-key authentication middleware
  ratelimit.ts  token-bucket Lua script + rate-limit middleware
  overload.ts   in-flight counter + MAX_IN_FLIGHT cap (overload detection)
  queue.ts      RabbitMQ topology: direct exchange + per-tier queues
  dispatch.ts   fork: forward directly, or enqueue (bounded, timed) + priority consumer
  forward.ts    proxy a request to the backend
  metrics.ts    Prometheus metrics (registry, counters, gauge, histogram)
scripts/
  loadtest.ts       concurrent per-tier burst (rate-limit proof)
  demo-overload.ts  overload/priority demo (T3 served before T1)
  ci-local.sh       run the CI pipeline locally (boot -> test -> teardown)
tests/
  integration.test.ts  health + auth
  ratelimit.test.ts    Redis rate limiting (429 + headers)
  overload.test.ts     RabbitMQ overload priority (T3 before T1)
  loadshed.test.ts     queue full / wait timeout -> 503
  helpers.ts           shared test helpers
monitoring/
  prometheus.yml            Prometheus scrape config
  Dockerfile.prometheus     bakes the scrape config into the image
  grafana/                  provisioned datasource + Bouncer dashboard (as code)
.github/workflows/
  ci.yml            GitHub Actions: typecheck, build image, boot stack, run tests, tear down
```

## Roadmap

- [x] **v1 — Redis rate limiting** (token bucket, atomic Lua, fail-open)
- [x] **v2 — RabbitMQ tiered prioritization** (overload detection, publish, priority consumer)
- [x] **CI** — GitHub Actions integration tests (Redis + RabbitMQ)
- [x] **Monitoring** — `/metrics` + Prometheus + a provisioned Grafana dashboard
- [x] **Production hardening** — multi-stage non-root image, Redis-clock + EVALSHA token bucket, load shedding (bounded queues + max wait)
- [ ] **CD** — deploy to AWS

## Scope

**In scope:** per-tenant tier-based rate limiting on a single Redis instance,
request forwarding, tier-based priority queuing under overload via RabbitMQ, run
locally via Docker Compose.

**Not in scope:** distributed/multi-Redis limiting, multi-instance Bouncer,
per-endpoint or per-IP limits, real auth/key management, streaming/websocket
proxying, TLS termination.

## License

[MIT](LICENSE) © İlker Ekin Erdoğdu
