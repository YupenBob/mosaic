/**
 * JWT authentication middleware for Hono.
 * Extracts Bearer token from Authorization header and validates it.
 */

import { createMiddleware } from 'hono/factory';
import { verifyToken } from '../services/auth';
import type { Env } from '../types';

/**
 * Middleware that verifies the JWT token from the Authorization header.
 * Sets `isAuthenticated` and `authPayload` on the context.
 */
export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    isAuthenticated: boolean;
    authPayload: { sub: string } | null;
  };
}>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    c.set('isAuthenticated', false);
    c.set('authPayload', null);
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token, c.env);

  if (!payload) {
    c.set('isAuthenticated', false);
    c.set('authPayload', null);
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  c.set('isAuthenticated', true);
  c.set('authPayload', payload);
  await next();
});
