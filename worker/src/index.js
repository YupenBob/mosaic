/**
 * Mosaic Worker API — Cloudflare Workers entry point using Hono.
 * Routes: auth, posts CRUD, upload presign, build trigger/status, config.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loginHandler, authMiddleware, clientIp } from './auth.js';
import { listPosts, getPost, createOrUpdatePost, deletePost, dispatchBuild, getLatestRun, getConfig, updateConfig, markDirty, clearDirty, isDirty, renameCategory, renameTag, removeCategory, removeTag } from './github.js';
import { generatePresignedUrl, uploadComplete, listMedia, serveMediaFile, uploadDirect, deleteMediaFile } from './r2.js';
import { StatsDurableObject } from './stats-do.js';
import { readUsageSnapshot, writeUsageSnapshot, invalidateUsageSnapshot } from './usage.js';

const app = new Hono();
// Run a fire-and-forget task; executionCtx only exists in Workers runtimes.
function defer(c, fn) {
  try {
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(fn()); return; }
  } catch {}
  fn();
}

// ── CORS ──
// Public read/track endpoints stay wide open (*); everything else (admin
// auth/config/posts/upload/build) only reflects an Origin that is explicitly
// allowlisted (ALLOWED_ORIGINS, comma-separated; default: admin domain).
const PUBLIC_CORS_PREFIXES = ['/api/health', '/api/stats/', '/api/track/', '/api/media/'];
const DEFAULT_ALLOWED_ORIGINS = 'https://mosaic-admin.xsanye.cn';

function isPublicPath(path) {
  return PUBLIC_CORS_PREFIXES.some((p) => path.startsWith(p));
}

app.use('*', cors({
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
}));

// ====== Auth (no middleware) ======
app.post('/api/auth/login', loginHandler);

// Health check — public
app.get('/api/health', (c) => c.json({ status: 'ok', ok: true, version: '0.8.0' }));
app.get('/api/health/github', (c) => c.json({ status: 'ok', latency: 0 }));
app.get('/api/health/r2', (c) => c.json({ status: 'ok', latency: 0 }));

// Stats are served by the StatsDurableObject (single instance, serialized writes).
function statsURL(path, slug) {
  return new URL(`https://stats.local${path}${slug ? '?slug=' + encodeURIComponent(slug) : ''}`);
}

// Classic Durable Object namespace access (idFromName -> get -> stub.fetch)
async function statsFetch(c, path, slug, init = {}) {
  const id = c.env.STATS.idFromName('global');
  const stub = c.env.STATS.get(id);
  return stub.fetch(statsURL(path, slug), init);
}

// ── Parallel R2 traversal ──
// R2 list cursors are sequential per prefix, but top-level prefixes are
// independent, so scanning originals/ + processed/ + site-data/ in parallel
// cuts full-bucket traversals (disk/cleanup) to ~1/3 of wall time.
async function bucketUsage(env) {
  const parts = await Promise.all(['originals/', 'processed/', 'site-data/'].map(async (prefix) => {
    let size = 0, objects = 0, cursor;
    do {
      const opts = { prefix, limit: 1000 };
      if (cursor) opts.cursor = cursor;
      const list = await env.MEDIA.list(opts);
      for (const obj of (list.objects || [])) { size += obj.size; objects++; }
      cursor = list.truncated ? list.cursor : null;
    } while (cursor);
    return { size, objects };
  }));
  return {
    size: parts.reduce((a, b) => a + b.size, 0),
    objects: parts.reduce((a, b) => a + b.objects, 0),
  };
}

let _diskCache = null, _diskAt = 0;
const DISK_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function getDiskUsage(env) {
  if (_diskCache && Date.now() - _diskAt < DISK_CACHE_TTL_MS) return _diskCache;
  const snap = await readUsageSnapshot(env);
  if (snap && Date.now() - (snap.updatedAt || 0) < USAGE_SNAPSHOT_MAX_AGE_MS) {
    _diskCache = { size: snap.size, objects: snap.objects };
    _diskAt = Date.now();
    return _diskCache;
  }
  _diskCache = await bucketUsage(env);
  _diskAt = Date.now();
  // Persist the fresh totals so subsequent reads are cheap.
  await writeUsageSnapshot(env, _diskCache.size, _diskCache.objects);
  return _diskCache;
}

async function scanOrphans(env, valid, mode) {
  const parts = await Promise.all(['originals/', 'processed/'].map(async (prefix) => {
    let orphans = [], freed = 0, deleted = 0, cursor;
    do {
      const opts = { prefix, limit: 1000 };
      if (cursor) opts.cursor = cursor;
      const list = await env.MEDIA.list(opts);
      for (const o of (list.objects || [])) {
        const slug = o.key.split('/')[1];
        if (!slug || valid.has(slug)) continue;
        if (mode === 'delete') { await env.MEDIA.delete(o.key); deleted++; freed += o.size; }
        else orphans.push({ key: o.key, size: o.size });
      }
      cursor = list.truncated ? list.cursor : null;
    } while (cursor);
    return { orphans, freed, deleted };
  }));
  const total = parts.reduce((acc, p) => ({
    orphans: acc.orphans.concat(p.orphans),
    freed: acc.freed + p.freed,
    deleted: acc.deleted + p.deleted,
  }), { orphans: [], freed: 0, deleted: 0 });
  if (mode === 'delete' && total.deleted > 0) await invalidateUsageSnapshot(env);
  return total;
}

// Track view — public (dedup by IP: 10min cooldown)
app.post('/api/track/view/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!slug) return c.json({ error: 'slug required' }, 400);
  try {
    const resp = await statsFetch(c, '/view', slug, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': await clientIp(c) },
      body: '{}',
    });
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Track like — public
app.post('/api/track/like/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!slug) return c.json({ error: 'slug required' }, 400);
  let body = {};
  try { body = await c.req.json(); } catch {}
  try {
    const resp = await statsFetch(c, '/like', slug, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: body.action || 'like' }),
    });
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Track dwell time — public (capped at 2h per session)
app.post('/api/track/dwell/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!slug) return c.json({ error: 'slug required' }, 400);
  let body = {};
  try { body = await c.req.json(); } catch {}
  try {
    const resp = await statsFetch(c, '/dwell', slug, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: parseInt(body.seconds) || 0 }),
    });
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Traffic stats — aggregated by the Durable Object, enriched with post titles.
// NOTE: must be registered BEFORE /api/stats/:slug so the static path wins.
app.get('/api/stats/traffic', async (c) => {
  try {
    const resp = await statsFetch(c, '/traffic', null, { method: 'POST', body: '{}' });
    const data = await resp.json();
    const posts = await listPosts(c).catch(() => []);
    const validSlugs = new Set(posts.map((p) => p.slug));
    const titleMap = Object.fromEntries(posts.map((p) => [p.slug, p.title || p.slug]));
    data.top5 = (data.top5 || [])
      .filter((e) => validSlugs.has(e.slug))
      .map((e) => ({ ...e, title: titleMap[e.slug] || e.slug }));
    return c.json(data);
  } catch { return c.json({ total: 0, totalLikes: 0, posts: 0, byDay: [], byCategory: [], byTag: [], top5: [] }); }
});

// Bulk per-post stats for the admin posts list (60s worker-memory cache).
// Registered before /api/stats/:slug so the static path wins.
let _postStatsCache = null;
let _postStatsAt = 0;
app.get('/api/stats/posts', async (c) => {
  if (_postStatsCache && Date.now() - _postStatsAt < 60000) return c.json(_postStatsCache);
  try {
    const posts = await listPosts(c);
    const arr = await Promise.all(posts.slice(0, 500).map(async (p) => {
      try {
        const resp = await statsFetch(c, '/stats', p.slug, { method: 'POST', body: '{}' });
        const d = await resp.json();
        return { slug: p.slug, views: d.views || 0, likes: d.likes || 0 };
      } catch {
        return { slug: p.slug, views: 0, likes: 0 };
      }
    }));
    const statsMap = Object.fromEntries(arr.map((s) => [s.slug, { views: s.views, likes: s.likes }]));
    _postStatsCache = { stats: statsMap, updatedAt: new Date().toISOString() };
    _postStatsAt = Date.now();
    return c.json(_postStatsCache);
  } catch (e) {
    return c.json({ stats: {} });
  }
});

// Live stats for a single post — public
app.get('/api/stats/:slug', async (c) => {
  const slug = c.req.param('slug');
  try {
    const resp = await statsFetch(c, '/stats', slug, { method: 'POST', body: '{}' });
    return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Media file serving — public (uses R2_PUBLIC_URL or falls back to config.mediaBase)
app.get('/api/media/file/:slug/:filename', async (c) => {
  let cfg = {};
  try { cfg = await getConfig(c); } catch {}
  return serveMediaFile(c, cfg.mediaBase);
});

// Upload — public (admin sends JWT in XHR)
app.post('/api/upload/direct/:slug/:filename', async (c) => {
  const result = await uploadDirect(c);
  defer(c, () => markDirty(c.env));
  return result;
});

// ====== Protected routes ======
app.use('/api/*', authMiddleware);

// Inject X-Dirty header on all API responses
app.use('/api/*', async (c, next) => {
  await next();
  const dirty = await isDirty(c.env);
  if (dirty) c.res.headers.set('X-Dirty', `${dirty.count}|${dirty.last}`);
});

// Dirty state query
app.get('/api/dirty', async (c) => {
  const dirty = await isDirty(c.env);
  return c.json(dirty || { count: 0 });
});

// Posts CRUD
app.get('/api/posts', async (c) => {
  try {
    const posts = await listPosts(c);
    const limit = Math.min(Math.max(parseInt(c.req.query('limit')) || 0, 0), 500);
    const cursor = c.req.query('cursor') || '';
    if (!limit) return c.json({ posts, total: posts.length });
    const start = cursor ? posts.findIndex((p) => p.slug === cursor) + 1 : 0;
    if (start < 0) return c.json({ posts: [], total: posts.length, nextCursor: null });
    const page = posts.slice(start, start + limit);
    const nextCursor = start + limit < posts.length ? posts[Math.min(start + limit, posts.length - 1)].slug : null;
    return c.json({ posts: page, total: posts.length, nextCursor });
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
    defer(c, () => markDirty(c.env));
    return c.json({ ok: true, slug, sha: result.content?.sha }, 201);
  } catch (e) { return c.json({ error: e.message, code: e.message.includes('exists') ? 'SLUG_CONFLICT' : 'GITHUB_ERROR' }, e.message.includes('exists') ? 409 : 502); }
});

app.delete('/api/posts/:slug', async (c) => {
  try {
    const slug = c.req.param('slug');
    const { message } = await c.req.json().catch(() => ({}));

    // Delete from GitHub
    const result = await deletePost(c, slug, message);

    // Delete from R2 (originals + processed)
    let r2Count = 0;
    for (const prefix of ['originals', 'processed']) {
      let cursor;
      do {
        try {
          const opts = { prefix: `${prefix}/${slug}/`, limit: 1000 };
          if (cursor) opts.cursor = cursor;
          const list = await c.env.MEDIA.list(opts);
          for (const obj of (list.objects || [])) {
            await c.env.MEDIA.delete(obj.key);
            r2Count++;
          }
          cursor = list.truncated ? list.cursor : null;
        } catch {
          cursor = null;
        }
      } while (cursor);
    }
    if (r2Count > 0) result.r2Deleted = r2Count;
    if (r2Count > 0) await invalidateUsageSnapshot(c.env);

    defer(c, () => markDirty(c.env));
    return c.json(result);
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Upload
app.post('/api/upload/presign', generatePresignedUrl);
app.post('/api/upload/complete/:slug/:filename', uploadComplete);

// Build
app.post('/api/build', async (c) => {
  try {
    // Check if build is already running
    const latest = await getLatestRun(c);
    if (latest && latest.status === 'in_progress') {
      return c.json({ error: 'Build already in progress', code: 'BUILD_RUNNING', run: { id: latest.id, url: latest.html_url } }, 409);
    }
    await dispatchBuild(c);
    defer(c, () => clearDirty(c.env));
    return c.json({ ok: true, message: 'Build triggered' });
  } catch (e) { return c.json({ error: e.message, code: 'DISPATCH_ERROR' }, 502); }
});

app.get('/api/build/history', async (c) => {
  try {
    const resp = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/actions/workflows/pipeline.yml/runs?per_page=10`, {
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Mosaic/0.8' },
    });
    if (!resp.ok) return c.json({ runs: [] });
    const data = await resp.json();
    const repo = c.env.GITHUB_REPO;
    return c.json({ runs: (data.workflow_runs || []).map(r => ({
      id: r.id, runNumber: r.run_number, status: r.status, conclusion: r.conclusion,
      displayTitle: r.display_title, headBranch: r.head_branch,
      headSha: r.head_sha?.slice(0, 7), headShaFull: r.head_sha || '',
      commitUrl: r.head_sha ? `https://github.com/${repo}/commit/${r.head_sha}` : '',
      commitMessage: r.head_commit?.message?.split('\n')[0] || '', htmlUrl: r.html_url,
      createdAt: r.created_at, updatedAt: r.updated_at, event: r.event,
    })) });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

app.get('/api/build/status', async (c) => {
  try {
    const run = await getLatestRun(c);
    if (!run) return c.json({ status: 'unknown' });
    return c.json(run);
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Live build progress reported by the pipeline (R2 site-data/build-progress.json)
app.get('/api/build/progress', async (c) => {
  try {
    const obj = await c.env.MEDIA.get('site-data/build-progress.json');
    if (!obj) return c.json({ stage: '', updatedAt: null });
    const data = JSON.parse(await obj.text());
    return c.json(data);
  } catch (e) { return c.json({ error: e.message, code: 'R2_ERROR' }, 502); }
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
    defer(c, () => markDirty(c.env));
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
    defer(c, () => markDirty(c.env));
    return c.json({ ok: true, slug });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Media list — from R2 (uses R2_PUBLIC_URL or falls back to config.mediaBase)
app.get('/api/media/:slug/list', async (c) => {
  let cfg = {};
  try { cfg = await getConfig(c); } catch {}
  return listMedia(c, cfg.mediaBase);
});

// Delete a single media file (originals + processed)
app.delete('/api/media/:slug/:file', async (c) => {
  const result = await deleteMediaFile(c);
  defer(c, () => markDirty(c.env));
  return result;
});

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

// Rename category (rewrites frontmatter in every affected post)
app.put('/api/taxonomy/category', async (c) => {
  try {
    const { oldName, newName, message } = await c.req.json().catch(() => ({}));
    if (!oldName || !newName) return c.json({ error: 'oldName and newName required', code: 'INVALID_PARAMS' }, 400);
    const renamed = await renameCategory(c, oldName, newName, message);
    defer(c, () => markDirty(c.env));
    return c.json({ ok: true, renamed });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Rename tag (rewrites frontmatter in every affected post)
app.put('/api/taxonomy/tag', async (c) => {
  try {
    const { oldName, newName, message } = await c.req.json().catch(() => ({}));
    if (!oldName || !newName) return c.json({ error: 'oldName and newName required', code: 'INVALID_PARAMS' }, 400);
    const renamed = await renameTag(c, oldName, newName, message);
    defer(c, () => markDirty(c.env));
    return c.json({ ok: true, renamed });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Delete category — remove it from every post that uses it
app.delete('/api/taxonomy/category', async (c) => {
  try {
    const { name, message } = await c.req.json().catch(() => ({}));
    if (!name) return c.json({ error: 'name required', code: 'INVALID_PARAMS' }, 400);
    const affected = await removeCategory(c, name, message);
    defer(c, () => markDirty(c.env));
    return c.json({ ok: true, affected });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Delete tag — remove it from every post that uses it
app.delete('/api/taxonomy/tag', async (c) => {
  try {
    const { name, message } = await c.req.json().catch(() => ({}));
    if (!name) return c.json({ error: 'name required', code: 'INVALID_PARAMS' }, 400);
    const affected = await removeTag(c, name, message);
    defer(c, () => markDirty(c.env));
    return c.json({ ok: true, affected });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Trash (stub — GitHub doesn't have trash, return empty)
app.get('/api/trash', (c) => c.json([]));

// Disk usage — real R2 stats
app.get('/api/disk', async (c) => {
  try {
    const { size: totalSize, objects: totalObjects } = await getDiskUsage(c.env);
    const GB = totalSize / 1024 / 1024 / 1024;
    const cost = (GB * 0.015).toFixed(2); // R2 storage: $0.015/GB/month
    return c.json({ size: totalSize, sizeMB: (totalSize / 1024 / 1024).toFixed(1), sizeGB: GB.toFixed(2), objects: totalObjects, cost: cost, currency: 'USD' });
  } catch (e) { return c.json({ error: e.message, code: 'R2_ERROR' }, 502); }
});

// Cleanup — find and delete orphaned R2 objects
app.get('/api/cleanup', async (c) => {
  try {
    const posts = await listPosts(c).catch(() => []);
    const valid = new Set(posts.map(p => p.slug));
    const { orphans } = await scanOrphans(c.env, valid, 'list');
    const total = orphans.reduce((a, o) => a + o.size, 0);
    return c.json({ orphans, totalSize: total, totalOrphans: orphans.length });
  } catch (e) { return c.json({ error: e.message }, 502); }
});

app.delete('/api/cleanup', async (c) => {
  try {
    const posts = await listPosts(c).catch(() => []);
    const valid = new Set(posts.map(p => p.slug));
    const { deleted, freed } = await scanOrphans(c.env, valid, 'delete');
    return c.json({ deleted, freed, freedMB: (freed / 1048576).toFixed(1) });
  } catch (e) { return c.json({ error: e.message }, 502); }
});

// Processed cache cleanup — delete all processed/ objects from R2
app.delete('/api/processed-cache', async (c) => {
  try {
    let deleted = 0, freed = 0, cursor;
    do {
      const opts = { prefix: 'processed/', limit: 500 };
      if (cursor) opts.cursor = cursor;
      const list = await c.env.MEDIA.list(opts);
      for (const obj of (list.objects || [])) {
        await c.env.MEDIA.delete(obj.key);
        deleted++;
        freed += obj.size;
      }
      cursor = list.truncated ? list.cursor : null;
    } while (cursor);
    if (deleted > 0) await invalidateUsageSnapshot(c.env);
    return c.json({ deleted, freed, freedMB: (freed / 1048576).toFixed(1) });
  } catch (e) { return c.json({ error: e.message, code: 'R2_ERROR' }, 502); }
});

// 404
app.all('*', (c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

export default app;
export { StatsDurableObject };
