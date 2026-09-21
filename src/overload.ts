// Tracks how many requests are currently in flight at the backend. When that
// exceeds MAX_IN_FLIGHT we consider the backend overloaded, and (in later steps)
// route new requests through the priority queue instead of forwarding directly.
//
// This is a simple in-process counter — it reflects one Bouncer instance, which
// is all v1/v2 target (single instance).

// Concurrency the backend can handle before we treat it as overloaded.
// Configurable via env (default 50); parsed so an explicit 0 is honored
// (0 forces every request through the queue — handy for testing/demos).
const parsedCap = Number(process.env.MAX_IN_FLIGHT);
export const MAX_IN_FLIGHT = Number.isFinite(parsedCap) ? parsedCap : 50;

let inFlightCount = 0;

// Call when a request is sent to the backend.
export function enter(): void {
  inFlightCount++;
  if (inFlightCount === MAX_IN_FLIGHT + 1) {
    console.warn(`Overload: in-flight exceeded ${MAX_IN_FLIGHT}`);
  }
}

// Call when a backend request finishes (success or failure).
export function leave(): void {
  if (inFlightCount > 0) inFlightCount--;
  if (inFlightCount === MAX_IN_FLIGHT) {
    console.info(`Overload cleared: in-flight back at ${MAX_IN_FLIGHT}`);
  }
}

export function inFlight(): number {
  return inFlightCount;
}

// True when the backend is at/over its concurrency cap.
export function isOverloaded(): boolean {
  return inFlightCount >= MAX_IN_FLIGHT;
}
