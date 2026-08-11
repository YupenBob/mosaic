/**
 * StatsDurableObject — single-instance counter store for views/likes/dwell.
 *
 * Root fix for stats.json read-modify-write races: all mutations are serialized
 * on one Durable Object instance via an in-isolate promise queue, so concurrent
 * track/like/dwell requests no longer lose updates.
 *
 * Storage: DO transactional storage (single map under key 'stats'). On first
 * load it seeds from R2 site-data/stats.json so existing counters survive the
 * migration; after each mutation a best-effort backup is written back to R2.
 */

const STORAGE_KEY = 'stats';
const MAX_HISTORY = 500;
const DEDUP_MS = 10 * 60 * 1000;
const MAX_DWELL = 7200;

// ── Global track rate limit ──
// The StatsDurableObject is a single instance, so a counter held here is
// global across all Worker isolates (unlike per-isolate in-memory limiters).
// The map lives in DO memory: it resets on eviction, which only means limits
// restart after a cold start — acceptable for abuse protection.
const TRACK_LIMIT = 60; // requests per minute per IP
const TRACK_WINDOW_MS = 60 * 1000;
const TRACK_MAP_MAX = 5000;
const _trackCounts = new Map();

function trackLimited(ip) {
  const now = Date.now();
  const entry = _trackCounts.get(ip);
  if (!entry || now - entry.start > TRACK_WINDOW_MS) {
    if (_trackCounts.size >= TRACK_MAP_MAX) {
      for (const [k, v] of _trackCounts) {
        if (now - v.start > TRACK_WINDOW_MS) _trackCounts.delete(k);
      }
    }
    _trackCounts.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > TRACK_LIMIT;
}

function ensure(map, slug) {
  if (!map[slug]) map[slug] = { views: 0, likes: 0, history: [] };
  else if (typeof map[slug] === 'number') map[slug] = { views: map[slug], likes: 0, history: [] };
  return map[slug];
}

// ── Pure mutations (exported for unit tests) ──
export function view(map, slug, ip) {
  const e = ensure(map, slug);
  const recents = e._recentIps || {};
  const now = Date.now();
  if (recents[ip] && now - recents[ip] < DEDUP_MS) {
    return { views: e.views || 0, likes: e.likes || 0, dedup: true };
  }
  recents[ip] = now;
  for (const [k, t] of Object.entries(recents)) {
    if (now - t > DEDUP_MS) delete recents[k];
  }
  e._recentIps = recents;
  e.views = (e.views || 0) + 1;
  e.history = e.history || [];
  e.history.push(new Date().toISOString());
  if (e.history.length > MAX_HISTORY) e.history = e.history.slice(-MAX_HISTORY);
  return { views: e.views, likes: e.likes || 0 };
}

export function like(map, slug, action) {
  const e = ensure(map, slug);
  e.likes = Math.max(0, (e.likes || 0) + (action === 'like' ? 1 : -1));
  return { likes: e.likes, views: e.views || 0 };
}

export function dwell(map, slug, seconds) {
  const e = ensure(map, slug);
  e.dwell_time = Math.max(e.dwell_time || 0, seconds);
  return { dwell_time: e.dwell_time };
}

export function entry(map, slug) {
  const raw = map[slug];
  if (!raw) return { slug, views: 0, likes: 0, dwell_time: 0 };
  const val = typeof raw === 'number' ? { views: raw, likes: 0 } : raw;
  return { slug, views: val.views || 0, likes: val.likes || 0, dwell_time: val.dwell_time || 0 };
}

export function aggregate(map) {
  const byCategory = {},
    byTag = {},
    byDay = {};
  let total = 0,
    totalLikes = 0;
  const entries = [];
  for (const [slug, raw] of Object.entries(map)) {
    const val = typeof raw === 'number' ? { views: raw, likes: 0, history: [], category: '', tags: [] } : raw;
    const count = val.views || val.count || 0;
    const likes = val.likes || 0;
    total += count;
    totalLikes += likes;
    entries.push({ slug, count, likes, category: val.category || '', tags: val.tags || [] });
    const topCat = (val.category || '').split('/')[0].trim() || 'uncategorized';
    byCategory[topCat] = (byCategory[topCat] || 0) + count;
    for (const t of val.tags || []) byTag[t] = (byTag[t] || 0) + count;
    for (const ts of val.history || []) {
      const d = String(ts).slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
    }
  }
  entries.sort((a, b) => b.count - a.count);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push({ date: d, count: byDay[d] || 0 });
  }
  return {
    total,
    totalLikes,
    posts: entries.length,
    byDay: days,
    byCategory: Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    byTag: Object.entries(byTag)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count })),
    top5: entries.slice(0, 5).map((e) => ({ slug: e.slug, count: e.count, likes: e.likes })),
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export class StatsDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._queue = Promise.resolve();
    this._map = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ip = request.headers.get('X-Real-IP') || request.headers.get('CF-Connecting-IP') || 'unknown';
    if ((path === '/view' || path === '/like' || path === '/dwell') && trackLimited(ip)) {
      return json({ error: 'Too many requests, try again later', code: 'TRACK_RATE_LIMITED' }, 429);
    }
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const slug = url.searchParams.get('slug') || body.slug || '';
    if (!slug && path !== '/traffic') return json({ error: 'slug required' }, 400);

    if (path === '/view') {
      const result = await this._mutate((map) => view(map, slug, ip));
      return json({ ok: true, views: result.views, likes: result.likes });
    }
    if (path === '/like') {
      const action = body.action || 'like';
      const result = await this._mutate((map) => like(map, slug, action));
      return json({ ok: true, likes: result.likes, views: result.views });
    }
    if (path === '/dwell') {
      const seconds = Math.min(Math.max(parseInt(body.seconds) || 0, 0), MAX_DWELL);
      const result = await this._mutate((map) => dwell(map, slug, seconds));
      return json({ ok: true, dwell_time: result.dwell_time });
    }
    if (path === '/stats') {
      try {
        const map = await this._load();
        return json(entry(map, slug));
      } catch (e) {
        return json({ error: e.message, stack: String(e.stack || e) }, 500);
      }
    }
    if (path === '/traffic') {
      try {
        const map = await this._load();
        return json(aggregate(map));
      } catch (e) {
        return json({ error: e.message, stack: String(e.stack || e) }, 500);
      }
    }
    return json({ error: 'Not found' }, 404);
  }

  async _load() {
    if (this._map) return this._map;
    let map = {};
    const stored = await this.state.storage.get(STORAGE_KEY);
    if (stored && typeof stored === 'object') map = stored;
    if (Object.keys(map).length === 0) {
      // Seed from R2 (migration path for existing counters)
      const obj = await this.env.MEDIA.get('site-data/stats.json');
      if (obj) map = JSON.parse(await obj.text());
    }
    this._map = map;
    return map;
  }

  _mutate(fn) {
    const run = async () => {
      const map = await this._load();
      const result = fn(map);
      try {
        await this.state.storage.put(STORAGE_KEY, map);
      } catch {}
      try {
        await this.env.MEDIA.put('site-data/stats.json', JSON.stringify(map), {
          httpMetadata: { contentType: 'application/json' },
        });
      } catch {}
      return result;
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }
}
