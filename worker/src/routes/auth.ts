/**
 * Auth routes: POST /auth/login, POST /auth/refresh
 */

import { Hono } from 'hono';
import { signToken, verifyToken } from '../services/auth';
import type { Env } from '../types';

const auth = new Hono<{ Bindings: Env }>();

/**
 * POST /auth/login
 * Body: { password: string }
 * Returns JWT token on success, 401 on wrong password.
 */
auth.post('/login', async (c) => {
  try {
    const { password } = await c.req.json<{ password: string }>();

    if (!password) {
      return c.json({ error: 'Password required' }, 400);
    }

    // Hash input password and compare with stored hash
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (hashHex !== c.env.ADMIN_PASSWORD_HASH) {
      return c.json({ error: 'Invalid password' }, 401);
    }

    const token = await signToken(c.env);
    const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

    return c.json({ token, expiresAt });
  } catch (err) {
    console.error('[auth] login error:', err instanceof Error ? err.message : String(err));
    return c.json({ error: 'Invalid request', detail: String(err) }, 400);
  }
});

/**
 * POST /auth/refresh
 * Requires valid JWT. Returns a new token with extended expiry.
 */
auth.post('/refresh', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token, c.env);

  if (!payload) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  const newToken = await signToken(c.env);
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  return c.json({ token: newToken, expiresAt });
});

export default auth;
