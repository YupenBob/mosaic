/**
 * Mosaic Worker API — Cloudflare Workers entry point using Hono.
 * Routes: auth, posts CRUD, upload presign, build trigger/status, config.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loginHandler, authMiddleware } from './auth.js';
import { listPosts, getPost, createOrUpdatePost, deletePost, dispatchBuild, getLatestRun, getConfig, updateConfig } from './github.js';
import { generatePresignedUrl, listMedia, serveMediaFile } from './r2.js';

const app = new Hono();

// CORS for cloud-admin
app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// ====== Auth (no middleware) ======
app.post('/api/auth/login', loginHandler);

// Health check — public, no auth required
app.get('/api/health', (c) => c.json({ status: 'ok', version: '0.8.0' }));

// Media file serving — public
app.get('/api/media/file/:slug/:filename', serveMediaFile);

// ====== Protected routes ======
app.use('/api/*', authMiddleware);

// Posts CRUD
app.get('/api/posts', async (c) => {
  try {
    const posts = await listPosts(c);
    return c.json({ posts, total: posts.length });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

app.get('/api/posts/:slug', async (c) => {
  try {
    const post = await getPost(c, c.req.param('slug'));
    if (!post) return c.json({ error: 'Post not found', code: 'NOT_FOUND' }, 404);
    return c.json(post);
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

app.post('/api/posts', async (c) => {
  try {
    const { slug, frontMatter, body, message } = await c.req.json();
    if (!slug) return c.json({ error: 'slug required', code: 'INVALID_PARAMS' }, 400);
    const result = await createOrUpdatePost(c, slug, frontMatter, body, message);
    return c.json({ ok: true, slug, sha: result.content?.sha }, 201);
  } catch (e) { return c.json({ error: e.message, code: e.message.includes('exists') ? 'SLUG_CONFLICT' : 'GITHUB_ERROR' }, e.message.includes('exists') ? 409 : 502); }
});

app.delete('/api/posts/:slug', async (c) => {
  try {
    const { message } = await c.req.json().catch(() => ({}));
    const result = await deletePost(c, c.req.param('slug'), message);
    return c.json(result);
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Upload
app.post('/api/upload/presign', generatePresignedUrl);

// Build
app.post('/api/build', async (c) => {
  try {
    // Check if build is already running
    const latest = await getLatestRun(c);
    if (latest && latest.status === 'in_progress') {
      return c.json({ error: 'Build already in progress', code: 'BUILD_RUNNING', run: { id: latest.id, url: latest.html_url } }, 409);
    }
    await dispatchBuild(c);
    return c.json({ ok: true, message: 'Build triggered' });
  } catch (e) { return c.json({ error: e.message, code: 'DISPATCH_ERROR' }, 502); }
});

app.get('/api/build/status', async (c) => {
  try {
    const run = await getLatestRun(c);
    if (!run) return c.json({ status: 'unknown' });
    return c.json({
      id: run.id,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      created_at: run.created_at,
    });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Config
app.get('/api/config', async (c) => {
  try {
    const cfg = await getConfig(c);
    return c.json(cfg);
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

app.put('/api/config', async (c) => {
  try {
    const { message, ...config } = await c.req.json();
    const result = await updateConfig(c, config, message);
    return c.json({ ok: true, sha: result.content?.sha });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Auth refresh
app.post('/api/auth/refresh', async (c) => {
  // Client already has valid JWT (verified by middleware), just return success
  return c.json({ ok: true });
});

// Duplicate post
app.post('/api/posts/:slug/duplicate', async (c) => {
  try {
    const post = await getPost(c, c.req.param('slug'));
    if (!post) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    const { newSlug } = await c.req.json().catch(() => ({}));
    const slug = newSlug || `${c.req.param('slug')}-copy`;
    await createOrUpdatePost(c, slug, post.frontMatter, post.body, `Duplicate ${c.req.param('slug')} → ${slug}`);
    return c.json({ ok: true, slug });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Media list — from R2
app.get('/api/media/:slug/list', listMedia);

// Stats
app.get('/api/stats', async (c) => {
  try {
    const posts = await listPosts(c);
    const cats = new Set(), tags = new Set();
    posts.forEach(p => { if (p.category) cats.add(p.category); (p.tags||[]).forEach(t => tags.add(t)); });
    return c.json({ posts: posts.length, categories: cats.size, tags: tags.size });
  } catch { return c.json({ posts: 0, categories: 0, tags: 0 }); }
});

// Taxonomy
app.get('/api/taxonomy', async (c) => {
  try {
    const posts = await listPosts(c);
    const cats = {}, tags = {};
    posts.forEach(p => {
      const c = p.category || 'uncategorized';
      cats[c] = (cats[c]||0) + 1;
      (p.tags||[]).forEach(t => { tags[t] = (tags[t]||0) + 1; });
    });
    return c.json({
      categories: Object.entries(cats).map(([n, c]) => ({ name: n, count: c })),
      tags: Object.entries(tags).map(([n, c]) => ({ name: n, count: c })),
    });
  } catch { return c.json({ categories: [], tags: [] }); }
});

// Trash (stub — GitHub doesn't have trash, return empty)
app.get('/api/trash', (c) => c.json([]));

// Disk usage (stub)
app.get('/api/disk', (c) => c.json({ content: 0, contentMB: '0' }));

// Recent files (stub)
app.get('/api/recent-files', (c) => c.json([]));

// Build logs (stub)
app.get('/api/logs', (c) => c.json([]));

// 404
app.all('*', (c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

export default app;
