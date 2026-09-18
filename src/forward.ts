import type { Request, Response } from "express";

// Where allowed requests get proxied. Defaults to the local whoami (host port);
// Docker Compose overrides this with the backend service address.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8080";

// Hop-by-hop headers: meaningful only for a single connection, must not be relayed.
const SKIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
]);

// Buffer the raw request body (none for GET/HEAD). Returned as a Uint8Array,
// which fetch accepts as a body (a Node Buffer is not directly assignable).
function collectBody(req: Request): Promise<Uint8Array | undefined> {
  if (req.method === "GET" || req.method === "HEAD") {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () =>
      resolve(chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined),
    );
    req.on("error", reject);
  });
}

// Proxy an allowed request to the backend and relay the response back.
export async function forward(req: Request, res: Response) {
  const url = BACKEND_URL + req.originalUrl;

  // Copy incoming headers, dropping hop-by-hop ones.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v && !SKIP_HEADERS.has(k.toLowerCase())) {
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
    });

    res.status(backendRes.status);
    backendRes.headers.forEach((value, key) => {
      if (!SKIP_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
    });
    res.send(Buffer.from(await backendRes.arrayBuffer()));
  } catch (err) {
    // Backend unreachable / failed: this is a gateway error, not the client's fault.
    console.error("Forward error:", err);
    res.status(502).json({ error: "bad_gateway" });
  }
}
