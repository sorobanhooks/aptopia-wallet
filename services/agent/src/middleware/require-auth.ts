import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth';

/**
 * A request that has passed `requireAuth`: `auth` is populated with the
 * authenticated wallet's claims. Route handlers that sit behind `requireAuth`
 * can accept this type instead of the bare `Request`.
 */
export interface AuthedRequest extends Request {
  auth?: { pubkey: string };
}

/**
 * Gate a route on a valid SIWE-issued JWT.
 *
 * Reads `Authorization: Bearer <jwt>`, verifies it (HS256, not expired),
 * and attaches `req.auth = { pubkey }`. Responds 401 on any failure.
 *
 * Applied to every `/v1/*` route except `/v1/auth/*` and `/v1/health`,
 * which are wired before this middleware in the router.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  try {
    const claims = verifyToken(match[1].trim());
    (req as AuthedRequest).auth = { pubkey: claims.pubkey };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Ownership guard helper for route handlers.
 *
 * The authed pubkey MUST equal the agent's `targetWallet` (the user's main
 * G-address). Returns true if the request is authorized; otherwise writes a
 * 401/403 response and returns false (caller should `return`).
 *
 * `agentTargetWallet` must be a non-empty string that matches the authed
 * pubkey.  If it is missing/falsy the check FAILS CLOSED with 403 — a null
 * targetWallet must never grant access.
 */
export function assertOwnsAgent(
  req: Request,
  res: Response,
  agentTargetWallet: string | null | undefined,
): boolean {
  const auth = (req as AuthedRequest).auth;
  if (!auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  if (!agentTargetWallet || auth.pubkey !== agentTargetWallet) {
    res.status(403).json({ error: 'Authenticated wallet does not own this agent' });
    return false;
  }
  return true;
}
