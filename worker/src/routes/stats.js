/**
 * Public tracking + stats endpoints (view/like/dwell, per-post) and the
 * admin-only reports (`/api/stats`, `/api/stats/posts`, `/api/stats/traffic`).
 *
 * Everything mutating/aggregating is a single Durable Object call: the DO owns
 * the schema and the traffic snapshot, so the Worker never fans out one request
 * per post.
 */
import { clientIp } from '../auth.js';
import { listPosts } from '../github.js';
import { statsFetch } from '../shared.js';

const MAX_SLUG_LENGTH = 120;

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Slugs accepted by the public track endpoints (same rule as the DO). */
export function validTrackSlug(slug) {
  return (
    typeof slug === 'string' &&
    !!slug &&
    slug.length <= MAX_SLUG_LENGTH &&
    !slug.includes('/') &&
    !slug.includes('\\') &&
    !hasControlCharacter(slug) &&
    slug !== '.' &&
    slug !== '..'
  );
}

function collectTrackSlug(c) {
  const slug = c.req.param('slug');
  if (!validTrackSlug(slug)) return null;
  return slug;
}

const STATS_HEADERS = { 'Content-Type': 'application/json' };

async function doJson(c, path, slug, { body = {}, headers = {} } = {}) {
  const response = await statsFetch(c, path, slug, {
    method: 'POST',
    headers: { ...STATS_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

let _postStatsCache = null;
let _postStatsAt = 0;

export function registerStatsPublic(app) {
  // Track view — public (dedup by IP: 10min cooldown)
  app.post('/api/track/view/:slug', async (c) => {
    const slug = collectTrackSlug(c);
    if (!slug) return c.json({ error: 'Invalid slug', code: 'INVALID_PARAMS' }, 400);
    try {
      const { response, data } = await doJson(c, '/view', slug, { headers: { 'X-Real-IP': await clientIp(c) } });
      return new Response(JSON.stringify(data), { status: response.status, headers: STATS_HEADERS });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // Track like — public
  app.post('/api/track/like/:slug', async (c) => {
    const slug = collectTrackSlug(c);
    if (!slug) return c.json({ error: 'Invalid slug', code: 'INVALID_PARAMS' }, 400);
    let body = {};
    try {
      body = await c.req.json();
    } catch {}
    try {
      const action = body.action === 'unlike' || body.action === 'down' ? 'unlike' : 'like';
      const { response, data } = await doJson(c, '/like', slug, {
        body: { action },
        headers: { 'X-Real-IP': await clientIp(c) },
      });
      return new Response(JSON.stringify(data), { status: response.status, headers: STATS_HEADERS });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // Track dwell time — public (capped at 2h per session)
  app.post('/api/track/dwell/:slug', async (c) => {
    const slug = collectTrackSlug(c);
    if (!slug) return c.json({ error: 'Invalid slug', code: 'INVALID_PARAMS' }, 400);
    let body = {};
    try {
      body = await c.req.json();
    } catch {}
    try {
      const seconds = parseInt(body.seconds) || 0;
      const { response, data } = await doJson(c, '/dwell', slug, {
        body: { seconds },
        headers: { 'X-Real-IP': await clientIp(c) },
      });
      return new Response(JSON.stringify(data), { status: response.status, headers: STATS_HEADERS });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // Live stats for a single post — public.
  // NOTE: `posts` and `traffic` are admin reports registered in
  // registerStatsProtected (after the auth middleware). This param route is
  // registered earlier, so those two names must fall through to reach the
  // protected handlers instead of being served publicly.
  app.get('/api/stats/:slug', async (c, next) => {
    const slug = c.req.param('slug');
    if (slug === 'posts' || slug === 'traffic') return next();
    try {
      const { response, data } = await doJson(c, '/stats', slug);
      return new Response(JSON.stringify(data), { status: response.status, headers: STATS_HEADERS });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });
}

export function registerStatsProtected(app) {
  // Bulk per-post stats for the admin posts list: one DO call, joined against
  // the post listing for slugs that have no counters yet.
  app.get('/api/stats/posts', async (c) => {
    if (_postStatsCache && Date.now() - _postStatsAt < 60000) return c.json(_postStatsCache);
    try {
      const [posts, bulk] = await Promise.all([
        listPosts(c),
        doJson(c, '/bulk', null)
          .then(({ data }) => data)
          .catch(() => ({ stats: {} })),
      ]);
      const remote = bulk.stats || {};
      const stats = Object.fromEntries(
        posts
          .slice(0, 500)
          .map((post) => [post.slug, { views: remote[post.slug]?.views || 0, likes: remote[post.slug]?.likes || 0 }]),
      );
      _postStatsCache = { stats, updatedAt: bulk.updatedAt || new Date().toISOString() };
      _postStatsAt = Date.now();
      return c.json(_postStatsCache);
    } catch {
      return c.json({ stats: {}, updatedAt: new Date().toISOString() });
    }
  });

  // Traffic report — aggregated by the Durable Object (30s cache inside), then
  // enriched with post titles. Also must be registered before `/api/stats/:slug`
  // in registration order terms; the param route falls through for us.
  app.get('/api/stats/traffic', async (c) => {
    try {
      const { data } = await doJson(c, '/traffic', null);
      const posts = await listPosts(c).catch(() => []);
      const validSlugs = new Set(posts.map((post) => post.slug));
      const titleMap = Object.fromEntries(posts.map((post) => [post.slug, post.title || post.slug]));
      data.top5 = (data.top5 || [])
        .filter((entry) => validSlugs.has(entry.slug))
        .map((entry) => ({ ...entry, title: titleMap[entry.slug] || entry.slug }));
      return c.json(data);
    } catch {
      return c.json({ total: 0, totalLikes: 0, posts: 0, byDay: [], byCategory: [], byTag: [], top5: [] });
    }
  });

  // Site content totals (posts/categories/tags) — not traffic data.
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
