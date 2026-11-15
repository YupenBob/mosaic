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
// Public beacons are tiny (view has no body, dwell a few bytes). Refuse oversized
// bodies before they reach the Durable Object.
const MAX_TRACK_BODY_BYTES = 8 * 1024;

function tooLargeBody(c) {
  const length = Number(c.req.header('content-length') || 0);
  if (Number.isFinite(length) && length > MAX_TRACK_BODY_BYTES) {
    return c.json({ error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' }, 413);
  }
  return null;
}

/**
 * Public tracking writes are anonymous, so refuse slugs that no *published*
 * post uses. The build index in R2 is the source of truth for pages that
 * actually exist; when it is missing (cold deploy, rollback, first build) we
 * fail open rather than lose real stats. The index is cached for a short while
 * per isolate because tracking endpoints are hit on every page view.
 */
const INDEX_CACHE_MS = 30000;
const postsIndexCache = new WeakMap();

async function publishedSlugs(c) {
  const cached = postsIndexCache.get(c.env);
  if (cached && cached.slugs && Date.now() - cached.at < INDEX_CACHE_MS) return cached.slugs;
  try {
    const obj =
      (await c.env.MEDIA.get('site-data/posts-index.json')) || (await c.env.MEDIA.get('site-data/posts.json'));
    if (!obj) return null;
    const posts = JSON.parse(await obj.text());
    if (!Array.isArray(posts) || posts.length === 0) return null;
    const slugs = new Set(posts.map((post) => post && post.slug).filter(Boolean));
    postsIndexCache.set(c.env, { at: Date.now(), slugs });
    return slugs;
  } catch {
    return null;
  }
}

async function isKnownPost(c, slug) {
  const slugs = await publishedSlugs(c);
  if (!slugs) return true;
  return slugs.has(slug);
}

function unknownPost(c) {
  return c.json({ error: 'Unknown post', code: 'UNKNOWN_POST' }, 404);
}

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
    const oversized = tooLargeBody(c);
    if (oversized) return oversized;
    if (!(await isKnownPost(c, slug))) return unknownPost(c);
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
    const oversized = tooLargeBody(c);
    if (oversized) return oversized;
    if (!(await isKnownPost(c, slug))) return unknownPost(c);
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
    const oversized = tooLargeBody(c);
    if (oversized) return oversized;
    if (!(await isKnownPost(c, slug))) return unknownPost(c);
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
