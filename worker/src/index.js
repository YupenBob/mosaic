/**
 * Mosaic Worker API — Cloudflare Workers entry point using Hono.
 * Routes: auth, posts CRUD, upload presign, build trigger/status, config.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loginHandler, authMiddleware } from './auth.js';
import { listPosts, getPost, createOrUpdatePost, deletePost, dispatchBuild, getLatestRun, getConfig, updateConfig, markDirty, clearDirty, isDirty } from './github.js';
import { generatePresignedUrl, listMedia, serveMediaFile, uploadDirect } from './r2.js';

const app = new Hono();

// CORS for cloud-admin
app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// ====== Auth (no middleware) ======
app.post('/api/auth/login', loginHandler);

// Health check — public
app.get('/api/health', (c) => c.json({ status: 'ok', ok: true, version: '0.8.0' }));
app.get('/api/health/github', (c) => c.json({ status: 'ok', latency: 0 }));
app.get('/api/health/r2', (c) => c.json({ status: 'ok', latency: 0 }));

// Helper: parse stats from R2 (stats.json first, fallback to views.json)
async function getStats(env) {
  let data = {};
  try { const obj = await env.MEDIA.get('site-data/stats.json'); if (obj) data = JSON.parse(await obj.text()); } catch {}
  if (!Object.keys(data).length) {
    try { const obj = await env.MEDIA.get('site-data/views.json'); if (obj) data = JSON.parse(await obj.text()); } catch {}
  }
  return data;
}

// Track view — public (dedup by IP: 10min cooldown)
app.post('/api/track/view/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!slug) return c.json({ error: 'slug required' }, 400);
  try {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const key = 'site-data/stats.json';
    let data = {};
    try { const obj = await c.env.MEDIA.get(key); if (obj) data = JSON.parse(await obj.text()); } catch {}

    if (!data[slug]) data[slug] = { views: 0, likes: 0, history: [] };
    else if (typeof data[slug] === 'number') data[slug] = { views: data[slug], likes: 0, history: [] };

    // IP dedup: skip if same IP viewed in last 10 min
    const recents = data[slug]._recentIps || {};
    const now = Date.now();
    if (recents[ip] && (now - recents[ip] < 600000)) {
      return c.json({ ok: true, views: data[slug].views, likes: data[slug].likes, dedup: true });
    }
    recents[ip] = now;
    // Purge stale IPs
    for (const [k, t] of Object.entries(recents)) { if (now - t > 600000) delete recents[k]; }
    data[slug]._recentIps = recents;

    data[slug].views = (data[slug].views || 0) + 1;
    data[slug].history = data[slug].history || [];
    data[slug].history.push(new Date().toISOString());
    if (data[slug].history.length > 500) data[slug].history = data[slug].history.slice(-500);

    await c.env.MEDIA.put(key, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });
    return c.json({ ok: true, views: data[slug].views, likes: data[slug].likes });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Track like — public
app.post('/api/track/like/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!slug) return c.json({ error: 'slug required' }, 400);
  let body = {};
  try { body = await c.req.json(); } catch {}
  const action = body.action || 'like';
  try {
    const key = 'site-data/stats.json';
    let data = {};
    try { const obj = await c.env.MEDIA.get(key); if (obj) data = JSON.parse(await obj.text()); } catch {}

    if (!data[slug]) data[slug] = { views: 0, likes: 0, history: [] };
    else if (typeof data[slug] === 'number') data[slug] = { views: data[slug], likes: 0, history: [] };

    data[slug].likes = Math.max(0, (data[slug].likes || 0) + (action === 'like' ? 1 : -1));

    await c.env.MEDIA.put(key, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });
    return c.json({ ok: true, likes: data[slug].likes, views: data[slug].views || 0 });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Traffic stats — reads from R2 site-data/stats.json (fallback views.json)
app.get('/api/stats/traffic', async (c) => {
  try {
    const data = await getStats(c.env);

    const byCategory = {}, byTag = {};
    const byDay = {};
    let total = 0, totalLikes = 0;
    const entries = [];

    for (const [slug, val] of Object.entries(data)) {
      const entry = typeof val === 'number' ? { views: val, likes: 0, history: [] } : val;
      const count = entry.views || entry.count || 0;
      const likes = entry.likes || 0;
      const history = entry.history || [];
      const cat = entry.category || '';
      const tags = entry.tags || [];

      total += count;
      totalLikes += likes;
      entries.push({ slug, count, likes, category: cat, tags });

      const topCat = cat.split('/')[0].trim() || 'uncategorized';
      byCategory[topCat] = (byCategory[topCat] || 0) + count;
      for (const t of tags) { byTag[t] = (byTag[t] || 0) + count; }
      for (const ts of history) { const d = ts.slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
    }

    entries.sort((a, b) => b.count - a.count);

    const posts = await listPosts(c).catch(() => []);
    const validSlugs = new Set(posts.map(p => p.slug));
    const validEntries = entries.filter(e => validSlugs.has(e.slug));
    const titleMap = Object.fromEntries(posts.map(p => [p.slug, p.title || p.slug]));

    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      days.push({ date: d, count: byDay[d] || 0 });
    }

    return c.json({
      total, totalLikes, posts: entries.length, byDay: days,
      byCategory: Object.entries(byCategory).sort((a,b)=>b[1]-a[1]).map(([n,c])=>({name:n,count:c})),
      byTag: Object.entries(byTag).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([n,c])=>({name:n,count:c})),
      top5: validEntries.slice(0, 5).map(e => ({ slug: e.slug, count: e.count, likes: e.likes, title: titleMap[e.slug] || e.slug })),
    });
  } catch { return c.json({ total: 0, totalLikes: 0, posts: 0, byDay: [], byCategory: [], byTag: [], top5: [] }); }
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
  c.executionCtx.waitUntil(markDirty(c.env));
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
    c.executionCtx.waitUntil(markDirty(c.env));
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
      try {
        const list = await c.env.MEDIA.list({ prefix: `${prefix}/${slug}/` });
        for (const obj of (list.objects || [])) {
          await c.env.MEDIA.delete(obj.key);
          r2Count++;
        }
      } catch {}
    }
    if (r2Count > 0) result.r2Deleted = r2Count;

    c.executionCtx.waitUntil(markDirty(c.env));
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
    c.executionCtx.waitUntil(clearDirty(c.env));
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
    return c.json({ runs: (data.workflow_runs || []).map(r => ({
      id: r.id, runNumber: r.run_number, status: r.status, conclusion: r.conclusion,
      displayTitle: r.display_title, headBranch: r.head_branch, headSha: r.head_sha?.slice(0, 7),
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
    c.executionCtx.waitUntil(markDirty(c.env));
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
    c.executionCtx.waitUntil(markDirty(c.env));
    return c.json({ ok: true, slug });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Media list — from R2 (uses R2_PUBLIC_URL or falls back to config.mediaBase)
app.get('/api/media/:slug/list', async (c) => {
  let cfg = {};
  try { cfg = await getConfig(c); } catch {}
  return listMedia(c, cfg.mediaBase);
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

// Trash (stub — GitHub doesn't have trash, return empty)
app.get('/api/trash', (c) => c.json([]));

// Disk usage — real R2 stats
app.get('/api/disk', async (c) => {
  try {
    let totalSize = 0, totalObjects = 0;
    let cursor;
    do {
      const opts = { limit: 1000 };
      if (cursor) opts.cursor = cursor;
      const list = await c.env.MEDIA.list(opts);
      for (const obj of list.objects || []) { totalSize += obj.size; totalObjects++; }
      cursor = list.truncated ? list.cursor : null;
    } while (cursor);
    const GB = totalSize / 1024 / 1024 / 1024;
    const cost = (GB * 0.015).toFixed(2); // R2 storage: $0.015/GB/month
    return c.json({ size: totalSize, sizeMB: (totalSize / 1024 / 1024).toFixed(1), sizeGB: GB.toFixed(2), objects: totalObjects, cost: cost, currency: 'USD' });
  } catch (e) { return c.json({ error: e.message, code: 'R2_ERROR' }, 502); }
});

// Recent files (stub)
app.get('/api/recent-files', (c) => c.json([]));

// Build logs (stub)
app.get('/api/logs', (c) => c.json([]));

// Cleanup — find and delete orphaned R2 objects
app.get('/api/cleanup', async (c) => {
  try {
    const posts = await listPosts(c).catch(() => []);
    const valid = new Set(posts.map(p => p.slug));
    const orphans = []; let total = 0, cursor;
    do { const opts = { limit: 500 }; if (cursor) opts.cursor = cursor;
      const list = await c.env.MEDIA.list(opts);
      for (const o of (list.objects||[])) {
        const p = o.key.split('/');
        if (p.length>=3&&(p[0]==='originals'||p[0]==='processed')&&!valid.has(p[1])) { orphans.push({key:o.key,size:o.size}); total+=o.size; }
      }
      cursor = list.truncated ? list.cursor : null;
    } while (cursor);
    return c.json({ orphans, totalSize: total, totalOrphans: orphans.length });
  } catch (e) { return c.json({ error: e.message }, 502); }
});

app.delete('/api/cleanup', async (c) => {
  try {
    const posts = await listPosts(c).catch(() => []);
    const valid = new Set(posts.map(p => p.slug));
    let deleted=0, freed=0, cursor;
    do { const opts = { limit: 500 }; if (cursor) opts.cursor = cursor;
      const list = await c.env.MEDIA.list(opts);
      for (const o of (list.objects||[])) {
        const p = o.key.split('/');
        if (p.length>=3&&(p[0]==='originals'||p[0]==='processed')&&!valid.has(p[1])) { await c.env.MEDIA.delete(o.key); deleted++; freed+=o.size; }
      }
      cursor = list.truncated ? list.cursor : null;
    } while (cursor);
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
    return c.json({ deleted, freed, freedMB: (freed / 1048576).toFixed(1) });
  } catch (e) { return c.json({ error: e.message, code: 'R2_ERROR' }, 502); }
});

// 404
app.all('*', (c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

export default app;
