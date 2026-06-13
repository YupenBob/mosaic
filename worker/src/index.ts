/**
 * Mosaic v0.8 Worker API — Entry Point
 *
 * Routes:
 *   /auth/*        — authentication (login, refresh)
 *   /upload/*      — media upload sessions (presigned URLs)
 *   /publish/*     — trigger GitHub Actions builds
 *   /build/*       — build status and history
 *   /media/*       — media file listing and deletion
 *   /stats/*       — dashboard statistics
 *   /health        — public health check
 *
 * Architecture:
 *   Hono is used as the web framework. Each route group is a separate
 *   file under src/routes/. Services (R2, GitHub, Auth) are under
 *   src/services/. JWT middleware protects admin routes.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import auth from './routes/auth';
import upload from './routes/upload';
import publish from './routes/publish';
import build from './routes/build';
import media from './routes/media';
import stats from './routes/stats';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// ── CORS ──────────────────────────────────────
app.use(
  '*',
  cors({
    origin: (origin) => {
      // Allow Cloud Admin (admin.example.com) and the main site
      const allowed = ['admin.example.com', 'example.com'];
      if (!origin) return '*';
      try {
        const host = new URL(origin).hostname;
        // Allow any subdomain of the site domain (for preview deployments)
        if (host.endsWith('.pages.dev') || host === 'localhost') return origin;
        return allowed.some((d) => host === d || host.endsWith('.' + d)) ? origin : allowed[0];
      } catch {
        return allowed[0];
      }
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400,
  })
);

// ── Public Routes ────────────────────────────
app.get('/health', (c) =>
  c.json({
    status: 'ok',
    version: '0.8.0',
    timestamp: new Date().toISOString(),
  })
);

// ── Protected Routes ─────────────────────────
app.route('/auth', auth);
app.route('/upload', upload);
app.route('/publish', publish);
app.route('/build', build);
app.route('/media', media);
app.route('/stats', stats);

// ── 404 ──────────────────────────────────────
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// ── Error Handler ────────────────────────────
app.onError((err, c) => {
  console.error('[mosaic-api] Error:', err.message);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
