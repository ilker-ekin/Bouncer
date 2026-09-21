// v2 overload/priority demo.
//
// Shows that under backend overload, the T3 backlog is served before the T1
// backlog — priority overriding arrival order.
//
// Method:
//  1. Saturate the backend with `cap` slow "filler" requests so all direct slots
//     are busy (filler uses the T3 key, well under its rate limit; not measured).
//  2. Fire the measured burst (N T1 then N T3) — with the backend full, these all
//     QUEUE, so we compare like-with-like (no fast direct-served requests skewing
//     one tier). N stays under the T1 tier's rate-limit capacity so v1 limiting
//     doesn't interfere.
//  3. When filler finishes, the worker drains measured T3 before measured T1.
//
// Needs Bouncer against a slow backend with a low cap:
//   docker compose up --build        (backend go-httpbin, MAX_IN_FLIGHT=10)
//   npm run demo
import { API_KEYS, type Tier } from "../src/config";

const BASE = process.env.BOUNCER_URL ?? "http://localhost:3000";
const CAP = Number(process.env.DEMO_CAP) || 10; // should match server MAX_IN_FLIGHT
const PER_TIER = Number(process.env.DEMO_PER_TIER) || 15; // < T1 capacity (20)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// One demo API key per tier.
const keyByTier: Partial<Record<Tier, string>> = {};
for (const [key, tenant] of Object.entries(API_KEYS)) keyByTier[tenant.tier] ??= key;

type Result = { tier: Tier; ms: number; status: number };

async function fire(tier: Tier, key: string, path: string, start: number): Promise<Result> {
  let status = 0;
  try {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${key}` } });
    status = r.status;
    await r.arrayBuffer(); // drain the body so the request fully completes
  } catch {
    status = 0;
  }
  return { tier, ms: Date.now() - start, status };
}

function stats(results: Result[], tier: Tier) {
  const times = results
    .filter((r) => r.tier === tier)
    .map((r) => r.ms)
    .sort((a, b) => a - b);
  const ok = results.filter((r) => r.tier === tier && r.status === 200).length;
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  return { count: times.length, ok, min: times[0], avg, max: times[times.length - 1] };
}

function row(tier: Tier, s: ReturnType<typeof stats>) {
  return (
    `${tier}   ` +
    `${`${s.ok}/${s.count}`.padEnd(9)}` +
    `${String(s.min).padStart(6)}` +
    `${String(s.avg).padStart(7)}` +
    `${String(s.max).padStart(7)}`
  );
}

async function main() {
  const t1key = keyByTier.T1;
  const t3key = keyByTier.T3;
  if (!t1key || !t3key) throw new Error("need T1 and T3 demo keys in config");

  console.log(
    `Saturating backend with ${CAP} filler requests, then queuing ${PER_TIER}x T1 + ${PER_TIER}x T3\n`,
  );
  const start = Date.now();

  // 1. Filler: occupy every backend slot for ~2s (uses T3 key; not measured).
  const filler: Promise<Result>[] = [];
  for (let i = 0; i < CAP; i++) filler.push(fire("T3", t3key, "/delay/2", start));

  // 2. Once the backend is saturated, the measured burst all queues.
  await sleep(300);
  const jobs: Promise<Result>[] = [];
  for (let i = 0; i < PER_TIER; i++) jobs.push(fire("T1", t1key, "/delay/1", start));
  for (let i = 0; i < PER_TIER; i++) jobs.push(fire("T3", t3key, "/delay/1", start));

  const results = await Promise.all(jobs);
  await Promise.all(filler); // let filler settle

  const t3 = stats(results, "T3");
  const t1 = stats(results, "T1");
  console.log("tier   ok/total    min    avg    max   (ms to complete)");
  console.log(row("T3", t3));
  console.log(row("T1", t1));
  console.log();
  if (t3.ok === t3.count && t1.ok === t1.count && t3.avg < t1.avg) {
    console.log(
      `✓ Priority holds: the T3 backlog drained before T1 (avg ${t3.avg}ms vs ${t1.avg}ms).`,
    );
  } else {
    console.log(
      `✗ Unexpected result (T3 avg ${t3.avg}ms vs T1 ${t1.avg}ms, T1 ok ${t1.ok}/${t1.count}). ` +
        `Ensure the server has a slow backend and MAX_IN_FLIGHT=${CAP}.`,
    );
  }
}

main();
