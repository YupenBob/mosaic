/**
 * JWT auth middleware for Hono.
 * - POST /api/auth/login with password → returns JWT
 * - All other endpoints require Authorization: Bearer <JWT>
 *
 * Fail-closed policy:
 * - If JWT_SECRET is missing but ADMIN_PASSWORD is set → 503 (no token can be issued).
 * - Unauthenticated "dev mode" is only allowed when BOTH ADMIN_PASSWORD and JWT_SECRET
 *   are unset AND DEV_MODE=true (local wrangler dev). In that case a per-isolate random
 *   secret is used so forged tokens from other isolates are rejected.
 */
import { SignJWT, jwtVerify } from 'jose';

const JWT_EXPIRY = '24h';

// Per-isolate random secret for local dev only (lazy: crypto.getRandomValues
// is disallowed at global scope in the Workers runtime).
let _devSecret = null;

export function secretFor(c) {
  if (c.env.JWT_SECRET) return c.env.JWT_SECRET;
  if (c.env.DEV_MODE === 'true') {
    if (!_devSecret) _devSecret = crypto.getRandomValues(new Uint8Array(32));
    return _devSecret;
  }
  return null;
}

// ── Login rate limiting (in-memory, per-isolate) ──
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const _failures = new Map();

function isLocked(ip) {
  const entry = _failures.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) _failures.delete(ip);
  return false;
}

function recordFailure(ip) {
  const entry = _failures.get(ip) || { fails: 0, lockedUntil: 0 };
  entry.fails += 1;
  if (entry.fails >= MAX_FAILS) {
    entry.lockedUntil = Date.now() + LOCK_MS;
    entry.fails = 0;
  }
  _failures.set(ip, entry);
}

function resetFailures(ip) {
  _failures.delete(ip);
}

export async function loginHandler(c) {
  const { password } = await c.req.json().catch(() => ({}));
  const ip = c.req.header('CF-Connecting-IP') || 'unknown';
  const adminPw = c.env.ADMIN_PASSWORD || '';
  const secret = secretFor(c);

  if (!secret) {
    return c.json({ error: 'Server not configured (JWT_SECRET missing)', code: 'CONFIG_ERROR' }, 503);
  }
  if (!adminPw && c.env.DEV_MODE !== 'true') {
    return c.json({ error: 'Server not configured (ADMIN_PASSWORD missing)', code: 'CONFIG_ERROR' }, 503);
  }
  if (isLocked(ip)) {
    return c.json({ error: 'Too many attempts, try again later', code: 'AUTH_RATE_LIMITED' }, 429);
  }
  if (adminPw && password !== adminPw) {
    recordFailure(ip);
    return c.json({ error: 'Invalid password', code: 'AUTH_INVALID' }, 401);
  }

  resetFailures(ip);
  const key = new TextEncoder().encode(secret);
  const token = await new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(JWT_EXPIRY)
    .sign(key);
  return c.json({ token, expires: 86400 });
}

export async function authMiddleware(c, next) {
  const secret = secretFor(c);
  if (!secret) {
    return c.json({ error: 'Server not configured (JWT_SECRET missing)', code: 'CONFIG_ERROR' }, 503);
  }
  if (!c.env.ADMIN_PASSWORD && c.env.DEV_MODE !== 'true') {
    return c.json({ error: 'Server not configured (ADMIN_PASSWORD missing)', code: 'CONFIG_ERROR' }, 503);
  }
  const header = c.req.header('Authorization') || '';
  const token = header.replace('Bearer ', '');
  if (!token) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    c.set('user', payload);
    await next();
  } catch {
    return c.json({ error: 'Token expired or invalid', code: 'AUTH_EXPIRED' }, 401);
  }
}

/** Shared token verification for routes that check auth inline (e.g. uploadDirect). */
export async function verifyToken(c, token) {
  const secret = secretFor(c);
  if (!secret) return { ok: false, code: 'CONFIG_ERROR', status: 503 };
  if (!c.env.ADMIN_PASSWORD && c.env.DEV_MODE !== 'true') {
    return { ok: false, code: 'CONFIG_ERROR', status: 503 };
  }
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    return { ok: true, payload };
  } catch {
    return { ok: false, code: 'AUTH_EXPIRED', status: 401 };
  }
}
