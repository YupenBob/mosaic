/**
 * Mosaic Worker API — Cloudflare Workers entry point using Hono.
 * Routes: auth, posts CRUD, upload presign, build trigger/status, config.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loginHandler, authMiddleware } from './auth.js';
import { listPosts, getPost, createOrUpdatePost, deletePost, dispatchBuild, getLatestRun, getRunHistory, getConfig, updateConfig } from './github.js';
import { generatePresignedUrl, uploadDirect, listMedia, serveMediaFile } from './r2.js';

const app = new Hono();

// CORS for cloud-admin
app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

// ====== Auth (no middleware) ======
app.post('/api/auth/login', loginHandler);

// Health check — public, no auth required
app.get('/api/health', (c) => c.json({ status: 'ok', ok: true, version: '0.8.0' }));

// Health — GitHub API
app.get('/api/health/github', async (c) => {
  const start = Date.now();
  try {
    const resp = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}`, {
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Mosaic/0.8' },
    });
    return c.json({ status: resp.ok ? 'ok' : 'error', code: resp.status, latency: Date.now() - start });
  } catch (e) { return c.json({ status: 'error', error: e.message, latency: Date.now() - start }); }
});

// Health — R2
app.get('/api/health/r2', async (c) => {
  const start = Date.now();
  try {
    await c.env.MEDIA.list({ limit: 1 });
    return c.json({ status: 'ok', latency: Date.now() - start });
  } catch (e) { return c.json({ status: 'error', error: e.message, latency: Date.now() - start }); }
});

// Media file serving — public, no auth (for <img> tags in admin)
app.get('/api/media/file/:slug/:filename', serveMediaFile);

// Track page view — public, no auth (called by frontend site)
app.post('/api/track/view', async (c) => {
  try {
    const { slug, category, tags } = await c.req.json().catch(() => ({}));
    if (!slug) return c.json({ error: 'slug required' }, 400);
    const key = 'site-data/views.json';
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    let data = {};
    try {
      const obj = await c.env.MEDIA.get(key);
      if (obj) data = JSON.parse(await obj.text());
    } catch {}

    // Migrate old format { slug: number } → { slug: { count, history[], ... } }
    if (typeof data[slug] === 'number') data[slug] = { count: data[slug], history: [] };
    if (!data[slug]) data[slug] = { count: 0, history: [] };
    data[slug].count++;
    data[slug].lastViewed = now;
    data[slug].history = (data[slug].history || []).slice(-365);
    data[slug].history.push(now);
    if (category) data[slug].category = category;
    if (tags?.length) data[slug].tags = tags;

    await c.env.MEDIA.put(key, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });
    return c.json({ ok: true, views: data[slug].count });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Like toggle — public
app.post('/api/like/:slug', async (c) => {
  try {
    const slug = c.req.param('slug');
    if (!slug) return c.json({ error: 'slug required' }, 400);
    const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
    const ua = c.req.header('User-Agent') || '';
    const fp = ip + '|' + ua.slice(0, 50);
    const fpHash = Array.from(new Uint8Array(new TextEncoder().encode(fp))).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

    const key = 'site-data/likes.json';
    const userKey = `site-data/like-users/${fpHash.slice(0, 32)}.json`;
    let likes = {}, userLikes = {};

    try { const obj = await c.env.MEDIA.get(key); if (obj) likes = JSON.parse(await obj.text()); } catch {}
    try { const obj = await c.env.MEDIA.get(userKey); if (obj) userLikes = JSON.parse(await obj.text()); } catch {}

    const liked = userLikes[slug];
    if (liked) {
      delete userLikes[slug];
      likes[slug] = Math.max(0, (likes[slug] || 1) - 1);
    } else {
      userLikes[slug] = Date.now();
      likes[slug] = (likes[slug] || 0) + 1;
    }

    await Promise.all([
      c.env.MEDIA.put(key, JSON.stringify(likes), { httpMetadata: { contentType: 'application/json' } }),
      c.env.MEDIA.put(userKey, JSON.stringify(userLikes), { httpMetadata: { contentType: 'application/json' } }),
    ]);

    return c.json({ liked: !liked, count: likes[slug] });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Get like count
app.get('/api/like/:slug/count', async (c) => {
  try {
    let likes = {};
    try { const obj = await c.env.MEDIA.get('site-data/likes.json'); if (obj) likes = JSON.parse(await obj.text()); } catch {}
    return c.json({ slug: c.req.param('slug'), count: likes[c.req.param('slug')] || 0 });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

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

// Upload — direct to R2 via Worker (primary)
app.post('/api/upload/direct/:slug/:filename', uploadDirect);

// Upload — presigned URL (fallback for large files)
app.post('/api/upload/presign', generatePresignedUrl);

// Build
app.post('/api/build', async (c) => {
  try {
    // Check if build is already running
    const latest = await getLatestRun(c);
    if (latest && (latest.status === 'in_progress' || latest.status === 'queued')) {
      return c.json({
        error: `Build already in progress — #${latest.runNumber || latest.id} ${latest.status}`,
        code: 'BUILD_RUNNING',
        run: { id: latest.id, runNumber: latest.runNumber, url: latest.htmlUrl, status: latest.status },
      }, 409);
    }
    const result = await dispatchBuild(c);
    return c.json({ ok: true, message: 'Build triggered', ...result });
  } catch (e) { return c.json({ error: e.message, code: 'DISPATCH_ERROR' }, 502); }
});

app.get('/api/build/history', async (c) => {
  try {
    const runs = await getRunHistory(c);
    return c.json({ runs });
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

// Media list — from R2 (shows uploaded files immediately)
app.get('/api/media/:slug/list', listMedia);

// Stats
app.get('/api/stats', async (c) => {
  try {
    const posts = await listPosts(c);
    const topCats = new Set(), tags = new Set();
    posts.forEach(p => {
      if (p.category) topCats.add(p.category.split('/')[0].trim());
      (p.tags||[]).forEach(t => tags.add(t));
    });
    return c.json({ posts: posts.length, categories: topCats.size, tags: tags.size });
  } catch { return c.json({ posts: 0, categories: 0, tags: 0 }); }
});

// Traffic stats — full analytics for dashboard charts
app.get('/api/stats/traffic', async (c) => {
  try {
    const key = 'site-data/views.json';
    let data = {};
    try { const obj = await c.env.MEDIA.get(key); if (obj) data = JSON.parse(await obj.text()); } catch {}

    const entries = [];
    let total = 0;
    const byDay = {};
    const byCategory = {};
    const byTag = {};

    for (const [slug, val] of Object.entries(data)) {
      const count = typeof val === 'number' ? val : (val.count || 0);
      const history = typeof val === 'number' ? [] : (val.history || []);
      const cat = typeof val === 'number' ? '' : (val.category || '');
      const tags = typeof val === 'number' ? [] : (val.tags || []);

      total += count;
      entries.push({ slug, count, category: cat, tags });

      if (cat) {
        const topCat = cat.split('/')[0].trim();
        byCategory[topCat] = (byCategory[topCat] || 0) + count;
      }

      for (const t of tags) {
        byTag[t] = (byTag[t] || 0) + count;
      }

      // Build daily buckets
      for (const ts of history) {
        const day = ts.slice(0, 10);
        byDay[day] = (byDay[day] || 0) + 1;
      }
    }

    entries.sort((a, b) => b.count - a.count);

    // Sort byDay and fill last 30 days
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key2 = d.toISOString().slice(0, 10);
      days.push({ date: key2, count: byDay[key2] || 0 });
    }

    // Category/tag → arrays for Chart.js
    const catEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    const tagEntries = Object.entries(byTag).sort((a, b) => b[1] - a[1]);

    return c.json({
      total,
      posts: entries.length,
      byDay: days,
      byCategory: catEntries.map(([name, count]) => ({ name, count })),
      byTag: tagEntries.slice(0, 10).map(([name, count]) => ({ name, count })),
      top5: entries.slice(0, 5),
    });
  } catch { return c.json({ total: 0, posts: 0, byDay: [], byCategory: [], byTag: [], top5: [] }); }
});

// Taxonomy — tree structure (multi-level via /)
app.get('/api/taxonomy', async (c) => {
  try {
    const posts = await listPosts(c);
    const catTree = {}, tags = {};

    for (const p of posts) {
      const parts = (p.category || 'uncategorized').split('/');
      let node = catTree;
      for (const part of parts) {
        const name = part.trim();
        if (!name) continue;
        if (!node[name]) node[name] = { _count: 0, _children: {} };
        node[name]._count++;
        node = node[name]._children;
      }
      (p.tags||[]).forEach(t => { tags[t] = (tags[t]||0) + 1; });
    }

    function buildTree(obj) {
      return Object.keys(obj).filter(k => !k.startsWith('_')).map(k => ({
        name: k,
        count: obj[k]._count,
        children: buildTree(obj[k]._children),
      }));
    }

    return c.json({
      categories: buildTree(catTree),
      tags: Object.entries(tags).map(([n, c]) => ({ name: n, count: c })),
    });
  } catch { return c.json({ categories: [], tags: [] }); }
});

// Taxonomy rename — update all posts referencing old name
app.put('/api/taxonomy/category', async (c) => {
  try {
    const { oldName, newName } = await c.req.json();
    if (!oldName || !newName) return c.json({ error: 'oldName and newName required', code: 'INVALID_PARAMS' }, 400);
    let count = 0;
    const posts = await listPosts(c);
    for (const p of posts) {
      if (p.category === oldName || p.category?.startsWith(oldName + '/')) {
        const post = await getPost(c, p.slug);
        if (post) {
          post.frontMatter.category = p.category === oldName ? newName : newName + p.category.slice(oldName.length);
          await createOrUpdatePost(c, p.slug, post.frontMatter, post.body, `Rename category ${oldName} → ${newName} in ${p.slug}`);
          count++;
        }
      }
    }
    return c.json({ ok: true, count });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

app.put('/api/taxonomy/tag', async (c) => {
  try {
    const { oldName, newName } = await c.req.json();
    if (!oldName || !newName) return c.json({ error: 'oldName and newName required', code: 'INVALID_PARAMS' }, 400);
    let count = 0;
    const posts = await listPosts(c);
    for (const p of posts) {
      if ((p.tags || []).includes(oldName)) {
        const post = await getPost(c, p.slug);
        if (post) {
          post.frontMatter.tags = (post.frontMatter.tags || []).map(t => t === oldName ? newName : t);
          await createOrUpdatePost(c, p.slug, post.frontMatter, post.body, `Rename tag ${oldName} → ${newName} in ${p.slug}`);
          count++;
        }
      }
    }
    return c.json({ ok: true, count });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Media delete — remove from R2 (and GitHub if exists)
app.delete('/api/media/:slug/:file', async (c) => {
  try {
    const slug = c.req.param('slug');
    const filename = c.req.param('file');
    // Try to find and delete from R2 first
    for (const folder of ['photos', 'videos', 'music', 'others']) {
      const key = `originals/${slug}/${folder}/${filename}`;
      const obj = await c.env.MEDIA.get(key);
      if (obj) {
        await c.env.MEDIA.delete(key);
        return c.json({ deleted: true, filename, source: 'r2' });
      }
    }
    // Fallback: try GitHub
    const resp = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/contents/content/posts/${slug}/${filename}`, {
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Mosaic/0.8' },
    });
    if (!resp.ok) return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
    const file = await resp.json();
    await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/contents/${file.path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Mosaic/0.8', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Delete ${filename}`, sha: file.sha }),
    });
    return c.json({ deleted: true, filename, source: 'github' });
  } catch (e) { return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502); }
});

// Admin: push files to GitHub (bypasses local git push issues — uses Worker's GITHUB_TOKEN)
app.post('/api/admin/push-files', async (c) => {
  try {
    const { files } = await c.req.json();
    if (!files || !Array.isArray(files)) return c.json({ error: 'files array required' }, 400);
    const ghHeaders = {
      Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json', 'User-Agent': 'Mosaic/0.8', 'Content-Type': 'application/json',
    };
    const encoder = new TextEncoder();
    function b64(s) {
      const bytes = encoder.encode(s);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    const results = [];
    for (const { path: filePath, content } of files) {
      let sha = '';
      try {
        const existing = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/contents/${filePath}`, { headers: ghHeaders });
        if (existing.ok) { const f = await existing.json(); sha = f.sha; }
      } catch {}
      const payload = { message: 'fix: build pipeline', content: b64(content) };
      if (sha) payload.sha = sha;
      const resp = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/contents/${filePath}`, {
        method: 'PUT', headers: ghHeaders, body: JSON.stringify(payload),
      });
      results.push({ path: filePath, status: resp.status, action: sha ? 'updated' : 'created' });
    }
    return c.json({ ok: true, results });
  } catch (e) { return c.json({ error: e.message }, 502); }
});

// Trash (stub — GitHub doesn't have trash, return empty)
app.get('/api/trash', (c) => c.json([]));
app.post('/api/trash/:dir/restore', (c) => c.json({ ok: true }));
app.delete('/api/trash/:dir', (c) => c.json({ ok: true }));

// Disk usage (stub)
app.get('/api/disk', (c) => c.json({ content: 0, contentMB: '0' }));

// Recent files (stub)
app.get('/api/recent-files', (c) => c.json([]));

// Build logs (stub)
app.get('/api/logs', (c) => c.json([]));

// 404
app.all('*', (c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

export default app;
