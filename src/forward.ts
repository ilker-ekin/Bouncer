import type { Request, Response } from "express";

// Where allowed requests get proxied. Defaults to the local whoami (host port);
// Docker Compose overrides this with the backend service address.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8080";

// Reject request bodies larger than this to avoid unbounded memory use (DoS).
const MAX_BODY_BYTES = 1_000_000; // 1 MB
// Give up on a slow/hung backend so connections don't pile up.
const BACKEND_TIMEOUT_MS = 10_000;

// Headers we never relay to the backend:
// - hop-by-hop headers (meaningful only for a single connection)
// - authorization: the client's API key is for Bouncer, not the backend
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization",
]);
// Hop-by-hop headers we don't relay back from the backend either.
const SKIP_RESPONSE_HEADERS = new Set([
  "connection",
  "transfer-encoding",
]);

class PayloadTooLargeError extends Error {}

// Buffer the raw request body (none for GET/HEAD), capped at MAX_BODY_BYTES.
// Returned as a Uint8Array, which fetch accepts as a body.
function collectBody(req: Request): Promise<Uint8Array | undefined> {
  if (req.method === "GET" || req.method === "HEAD") {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () =>
      resolve(chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined),
    );
    req.on("error", reject);
  });
}

// Proxy an allowed request to the backend and relay the response back.
export async function forward(req: Request, res: Response) {
  // Reject up front when the client declares an oversized body — returns a clean
  // 413 before reading anything (the streaming cap below is a memory backstop
  // for chunked uploads that don't declare a length).
  const declaredLength = Number(req.headers["content-length"]);
  if (declaredLength > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "payload_too_large" });
  }

  const url = BACKEND_URL + req.originalUrl;

  // Copy incoming headers, dropping the ones we must not forward.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v && !SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = Array.isArray(v) ? v.join(",") : v;
    }
  }

  try {
    const body = await collectBody(req);
    // Cast works around a @types/node vs fetch generics mismatch on Uint8Array;
    // fetch accepts a Uint8Array body fine at runtime.
    const backendRes = await fetch(url, {
      method: req.method,
      headers,
      body: body as RequestInit["body"],
      // Don't follow backend redirects server-side (SSRF risk) — relay the 3xx.
      redirect: "manual",
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });

    res.status(backendRes.status);
    backendRes.headers.forEach((value, key) => {
      if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
    });
    res.send(Buffer.from(await backendRes.arrayBuffer()));
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return res.status(413).json({ error: "payload_too_large" });
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      console.error("Forward timeout:", url);
      return res.status(504).json({ error: "gateway_timeout" });
    }
    // Backend unreachable / failed: a gateway error, not the client's fault.
    console.error("Forward error:", err);
    res.status(502).json({ error: "bad_gateway" });
  }
}
