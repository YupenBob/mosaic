/**
 * Public tracking + stats endpoints (view/like/dwell, traffic, per-post) and
 * the protected site-level stats endpoint.
 */
import { clientIp } from '../auth.js';
import { listPosts } from '../github.js';
import { statsFetch } from '../shared.js';

let _postStatsCache = null;
let _postStatsAt = 0;

export function registerStatsPublic(app) {
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
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // Track like — public
  app.post('/api/track/like/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (!slug) return c.json({ error: 'slug required' }, 400);
    let body = {};
    try {
      body = await c.req.json();
    } catch {}
    try {
      const resp = await statsFetch(c, '/like', slug, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: body.action || 'like' }),
      });
      return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // Track dwell time — public (capped at 2h per session)
  app.post('/api/track/dwell/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (!slug) return c.json({ error: 'slug required' }, 400);
    let body = {};
    try {
      body = await c.req.json();
    } catch {}
    try {
      const resp = await statsFetch(c, '/dwell', slug, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: parseInt(body.seconds) || 0 }),
      });
      return new Response(resp.body, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
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
    } catch {
      return c.json({ total: 0, totalLikes: 0, posts: 0, byDay: [], byCategory: [], byTag: [], top5: [] });
    }
  });

  // Bulk per-post stats for the admin posts list (60s worker-memory cache).
  // Registered before /api/stats/:slug so the static path wins.

  app.get('/api/stats/posts', async (c) => {
    if (_postStatsCache && Date.now() - _postStatsAt < 60000) return c.json(_postStatsCache);
    try {
      const posts = await listPosts(c);
      const arr = await Promise.all(
        posts.slice(0, 500).map(async (p) => {
          try {
            const resp = await statsFetch(c, '/stats', p.slug, { method: 'POST', body: '{}' });
            const d = await resp.json();
            return { slug: p.slug, views: d.views || 0, likes: d.likes || 0 };
          } catch {
            return { slug: p.slug, views: 0, likes: 0 };
          }
        }),
      );
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
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });
}

export function registerStatsProtected(app) {
  // Stats
  app.get('/api/stats', async (c) => {
    try {
      const posts = await listPosts(c);
      const cats = new Set(),
        tags = new Set();
      posts.forEach((p) => {
        if (p.category) cats.add(p.category);
        (p.tags || []).forEach((t) => tags.add(t));
      });
      return c.json({ posts: posts.length, categories: cats.size, tags: tags.size });
    } catch {
      return c.json({ posts: 0, categories: 0, tags: 0 });
    }
  });
}
