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
import { registerAssets, registerAssetsPublic } from './routes/assets.js';
import { registerDrafts } from './routes/drafts.js';
import { registerPreviewProtected, registerPreviewPublic } from './routes/preview.js';
import { registerThemes } from './routes/themes.js';
import { registerHistory } from './routes/history.js';
import { registerPosts } from './routes/posts.js';
import { registerBuild } from './routes/build.js';
import { registerConfig } from './routes/config.js';
import { registerTaxonomy } from './routes/taxonomy.js';
import { registerAdmin } from './routes/admin.js';
import { StatsDurableObject } from './stats-do.js';
import { JobsDurableObject } from './jobs-do.js';
import { registerInternalJobs, registerMediaJobs } from './routes/jobs.js';

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
    allowHeaders: ['Authorization', 'Content-Type', 'X-Mosaic-Keep-Source'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

// ── Uniform JSON-body validation ──
// Routes parse bodies lazily, so a malformed payload used to surface as a 502
// from whichever handler touched it last. Reject it up front with one shape.
// Streaming uploads carry the file itself (not JSON) and are excluded.
const RAW_BODY_PREFIXES = ['/api/upload/direct/'];
app.use('/api/*', async (c, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) return next();
  const path = new URL(c.req.url).pathname;
  if (RAW_BODY_PREFIXES.some((prefix) => path.startsWith(prefix))) return next();
  if (!(c.req.header('Content-Type') || '').toLowerCase().includes('application/json')) return next();
  let text;
  try {
    text = await c.req.raw.clone().text();
  } catch {
    return next();
  }
  if (!text.trim()) return next();
  try {
    JSON.parse(text);
  } catch {
    return c.json({ error: 'Malformed JSON body', code: 'INVALID_PARAMS' }, 400);
  }
  return next();
});

// ── Track endpoint rate limiting (public write paths) ──
app.use('/api/track/*', trackRateLimit);

// ====== Public routes (no auth) ======
app.post('/api/auth/login', loginHandler);
registerHealth(app);
registerStatsPublic(app);
registerMediaPublic(app);
registerAssetsPublic(app);
registerPreviewPublic(app);
registerInternalJobs(app);

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
registerAssets(app);
registerDrafts(app);
registerPreviewProtected(app);
registerThemes(app);
registerHistory(app);
registerPosts(app);
registerBuild(app);
registerConfig(app);
registerTaxonomy(app);
registerAdmin(app);
registerMediaJobs(app);

// 404
app.all('*', (c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

// ── Uniform error envelope ──
// Every handler that throws (or lets a rejected promise escape) ends up here:
// - 4xx keep their message (they describe a client mistake, e.g. malformed JSON)
// - 5xx are logged and flattened: internal messages must never reach clients.
app.onError((error, c) => {
  const explicit = Number.isInteger(error?.status) ? error.status : null;
  const status = explicit && explicit >= 400 && explicit < 600 ? explicit : error?.name === 'SyntaxError' ? 400 : 500;
  if (status >= 500) {
    console.error(`worker error ${c.req.method} ${new URL(c.req.url).pathname}:`, error);
    return c.json({ error: 'Internal server error', code: error?.code || 'INTERNAL_ERROR' }, status);
  }
  return c.json({ error: error?.message || 'Invalid request', code: error?.code || 'INVALID_PARAMS' }, status);
});

export default app;
export { StatsDurableObject, JobsDurableObject };
