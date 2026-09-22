import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from "@prometheus-io/client";
import { inFlight } from "./overload";
import type { Tier } from "./config";

export const registry = new Registry();

// Node process metrics (CPU, memory, event-loop lag) — free from the library.
collectDefaultMetrics({ register: registry });

// What the gateway decided for a request (mutually exclusive, one per request).
export type Outcome = "forwarded" | "queued" | "rate_limited" | "unauthorized";

// Total requests by tier and outcome. Graph its rate for traffic mix / 429 rate.
const requestsTotal = new Counter({
  name: "bouncer_requests_total",
  help: "Total requests processed, by tier and outcome",
  labelNames: ["tier", "outcome"] as const,
  registers: [registry],
});

// Live backend concurrency — reads straight from the overload counter on scrape.
new Gauge({
  name: "bouncer_in_flight",
  help: "Requests currently in flight at the backend",
  registers: [registry],
  collect() {
    this.set(inFlight());
  },
});

// Backend response latency by tier (for p50/p95/p99).
const backendDuration = new Histogram({
  name: "bouncer_backend_duration_seconds",
  help: "Backend request duration in seconds, by tier",
  labelNames: ["tier"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export function recordRequest(tier: Tier | "none", outcome: Outcome): void {
  requestsTotal.inc({ tier, outcome });
}

// Start timing a backend call; call the returned function when it finishes.
export function startBackendTimer(tier: Tier | "none"): () => void {
  return backendDuration.startTimer({ tier });
}
