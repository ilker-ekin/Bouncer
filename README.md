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

**Status:** v1 (Redis rate limiting) ✅ · v2 (RabbitMQ tiered prioritization) ✅ · CI ✅ · CD (AWS) planned.

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Usage](#usage)
- [Tiers](#tiers)
- [Load test & overload demo](#load-test--overload-demo)
- [Tests & CI](#tests--ci)
- [Configuration](#configuration)
- [Design notes (the "why")](#design-notes-the-why)
- [Project structure](#project-structure)
- [Roadmap](#roadmap)
- [Scope](#scope)
- [License](#license)

## Features

- **Per-tenant, tier-based rate limiting** — token bucket evaluated **atomically** in Redis via a Lua script (no race conditions).
- **API-key auth** — identity + tier resolved server-side; never client-declared.
- **Reverse proxy** — forwards allowed requests to a backend, with body-size limits, backend timeouts, and hop-by-hop header hygiene.
- **Tiered prioritization under overload** — requests beyond a concurrency cap are queued in RabbitMQ and drained **T3 → T2 → T1**.
- **Fail-open** — if Redis is unreachable, requests are allowed rather than dropped (availability over strict enforcement).
- **Fully containerized** — one `docker compose up` brings up the gateway, Redis, RabbitMQ, and a backend.
- **Integration-tested in CI** — GitHub Actions runs the suite against the real stack on every PR.

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

## Tech stack

| Concern | Choice |
|---------|--------|
| Language / runtime | TypeScript (strict), run via `tsx` on Node 22 |
| HTTP | Express |
| Rate limiting | Redis + Lua (`node-redis`) |
| Prioritization | RabbitMQ (`amqplib`) |
| Tests | `node:test` (zero-dependency) |
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
health, auth, Redis rate limiting, and RabbitMQ overload priority:

```bash
docker compose up -d --build   # start the stack
npm test                       # run the suite against it
```

Or run the whole pipeline (boot → wait for `/health` → test → tear down) in one
command, mirroring CI exactly:

```bash
npm run ci:local
```

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs that pipeline on
GitHub Actions — on every pull request targeting `main` (from any branch), on
pushes to `main`, and on manual dispatch. Enable branch protection requiring the
`CI` check to gate merges.

## Configuration

| Variable        | Default                                 | Purpose                                              |
|-----------------|-----------------------------------------|------------------------------------------------------|
| `PORT`          | `3000`                                  | Bouncer listen port                                  |
| `REDIS_URL`     | `redis://localhost:6379`                | Redis address                                        |
| `BACKEND_URL`   | `http://localhost:8080`                 | Backend to proxy allowed traffic to                  |
| `RABBITMQ_URL`  | `amqp://bouncer:bouncer@localhost:5672` | RabbitMQ address                                     |
| `MAX_IN_FLIGHT` | `50`                                    | Concurrent backend requests before overload (queuing) |

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

## Project structure

```
src/
  index.ts      app wiring: Redis + RabbitMQ connect, topology, routes, chain
  config.ts     tiers, limits, API key -> tenant table
  auth.ts       API-key authentication middleware
  ratelimit.ts  token-bucket Lua script + rate-limit middleware
  overload.ts   in-flight counter + MAX_IN_FLIGHT cap (overload detection)
  queue.ts      RabbitMQ topology: direct exchange + per-tier queues
  dispatch.ts   fork: forward directly, or enqueue + priority consumer
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

## Roadmap

- [x] **v1 — Redis rate limiting** (token bucket, atomic Lua, fail-open)
- [x] **v2 — RabbitMQ tiered prioritization** (overload detection, publish, priority consumer)
- [x] **CI** — GitHub Actions integration tests (Redis + RabbitMQ)
- [ ] **CD** — deploy to AWS
- [ ] **v3 (candidate)** — `/metrics` endpoint + Prometheus/Grafana observability

## Scope

**In scope:** per-tenant tier-based rate limiting on a single Redis instance,
request forwarding, tier-based priority queuing under overload via RabbitMQ, run
locally via Docker Compose.

**Not in scope:** distributed/multi-Redis limiting, multi-instance Bouncer,
per-endpoint or per-IP limits, real auth/key management, streaming/websocket
proxying, TLS termination.

## License

[MIT](LICENSE) © İlker Ekin Erdoğdu
