/**
 * JWT auth middleware for Hono.
 * - POST /api/auth/login with password → returns JWT
 * - All other endpoints require Authorization: Bearer <JWT>
 */
import { SignJWT, jwtVerify } from 'jose';

const JWT_SECRET = (ctx) => ctx.env.JWT_SECRET || 'mosaic-dev-secret';
const JWT_EXPIRY = '24h';

export async function loginHandler(c) {
  const { password } = await c.req.json().catch(() => ({}));
  const adminPw = c.env.ADMIN_PASSWORD || '';
  if (adminPw && password !== adminPw) {
    return c.json({ error: 'Invalid password', code: 'AUTH_INVALID' }, 401);
  }
  const secret = new TextEncoder().encode(JWT_SECRET(c));
  const token = await new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(JWT_EXPIRY)
    .sign(secret);
  return c.json({ token, expires: 86400 });
}

export async function authMiddleware(c, next) {
  // Skip auth in dev mode (no ADMIN_PASSWORD set)
  if (!c.env.ADMIN_PASSWORD) return await next();
  const header = c.req.header('Authorization') || '';
  const token = header.replace('Bearer ', '');
  if (!token) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);
  try {
    const secret = new TextEncoder().encode(JWT_SECRET(c));
    const { payload } = await jwtVerify(token, secret);
    c.set('user', payload);
    await next();
  } catch {
    return c.json({ error: 'Token expired or invalid', code: 'AUTH_EXPIRED' }, 401);
  }
}
