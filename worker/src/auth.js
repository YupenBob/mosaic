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

/**
 * Resolve the real client IP.
 * - The Pages Functions proxy signs the visitor's CF-Connecting-IP with an
 *   HMAC-SHA256 (X-Mosaic-Proxy-IP + X-Mosaic-Proxy-Time + X-Mosaic-Proxy-Sig),
 *   so the Worker can trust it without letting direct callers spoof it.
 * - Legacy transition: the previous static-header scheme (X-Mosaic-Proxy ===
 *   secret with X-Real-IP) is still accepted for one release cycle.
 * - When PROXY_SECRET is not configured (local dev), fall back to X-Real-IP /
 *   CF-Connecting-IP as-is.
 */
export async function clientIp(c) {
  const proxySecret = c.env.PROXY_SECRET;
  if (proxySecret) {
    const signedIp = c.req.header('X-Mosaic-Proxy-IP') || '';
    const sig = c.req.header('X-Mosaic-Proxy-Sig') || '';
    const time = c.req.header('X-Mosaic-Proxy-Time') || '';
    if (signedIp && sig && /^\d+$/.test(time) && (await verifyHmac(proxySecret, `${signedIp}:${time}`, sig))) {
      return signedIp;
    }
    const legacy = c.req.header('X-Mosaic-Proxy') || '';
    const legacyIp = c.req.header('X-Real-IP') || '';
    if (legacy === proxySecret && legacyIp) return legacyIp;
    return c.req.header('CF-Connecting-IP') || 'unknown';
  }
  return c.req.header('X-Real-IP') || c.req.header('CF-Connecting-IP') || 'unknown';
}

// Accepted clock skew between the Pages proxy and the Worker (minute buckets).
const HMAC_WINDOW_BUCKETS = 2;

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyHmac(secret, message, providedSig) {
  const bucket = Number(message.slice(message.lastIndexOf(':') + 1));
  const now = Math.floor(Date.now() / 60000);
  if (!Number.isInteger(bucket) || Math.abs(now - bucket) > HMAC_WINDOW_BUCKETS) return false;
  const expected = await hmacHex(secret, message);
  return safeEqual(expected, String(providedSig).toLowerCase());
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
  const ip = await clientIp(c);
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
