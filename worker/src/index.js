/**
 * Mosaic Worker API — Cloudflare Workers entry point using Hono.
 * Composition root: middleware + public/protected route groups.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loginHandler, authMiddleware, trackRateLimit } from './auth.js';
import { isDirty } from './github.js';
import { DEFAULT_ALLOWED_ORIGINS, isPublicPath } from './shared.js';
import { registerHealth } from './routes/health.js';
import { registerStatsPublic, registerStatsProtected } from './routes/stats.js';
import { registerMediaPublic, registerMediaProtected } from './routes/media.js';
import { registerPosts } from './routes/posts.js';
import { registerBuild } from './routes/build.js';
import { registerConfig } from './routes/config.js';
import { registerTaxonomy } from './routes/taxonomy.js';
import { registerAdmin } from './routes/admin.js';
import { StatsDurableObject } from './stats-do.js';

const app = new Hono();

// ── CORS ──
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      if (isPublicPath(new URL(c.req.url).pathname)) return '*';
      const allowed = (c.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return origin && allowed.includes(origin) ? origin : null;
    },
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

// ── Track endpoint rate limiting (public write paths) ──
app.use('/api/track/*', trackRateLimit);

// ====== Public routes (no auth) ======
app.post('/api/auth/login', loginHandler);
registerHealth(app);
registerStatsPublic(app);
registerMediaPublic(app);

// ====== Protected routes ======
app.use('/api/*', authMiddleware);

// Inject X-Dirty header on all API responses
app.use('/api/*', async (c, next) => {
  await next();
  const dirty = await isDirty(c.env);
  if (dirty) c.res.headers.set('X-Dirty', `${dirty.count}|${dirty.last}`);
});

app.post('/api/auth/refresh', async (c) => c.json({ ok: true }));
registerStatsProtected(app);
registerMediaProtected(app);
registerPosts(app);
registerBuild(app);
registerConfig(app);
registerTaxonomy(app);
registerAdmin(app);

// 404
app.all('*', (c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

export default app;
export { StatsDurableObject };
