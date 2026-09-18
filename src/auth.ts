import type { Request, Response, NextFunction } from "express";
import { API_KEYS, type Tenant } from "./config";

// Make the resolved tenant available to later handlers in a type-safe way.
declare global {
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
}

// Reads "Authorization: Bearer <key>", resolves it to a tenant, or rejects with 401.
// Identity is the key (a secret), resolved server-side — never a client-declared tenant/tier.
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.get("authorization");
  const key = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : undefined;

  if (!key) {
    return res.status(401).json({ error: "missing_api_key" });
  }

  const tenant = API_KEYS[key];
  if (!tenant) {
    return res.status(401).json({ error: "invalid_api_key" });
  }

  req.tenant = tenant;
  next();
}
