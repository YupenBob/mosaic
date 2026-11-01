/**
 * StatsDurableObject — single-instance counter store for views/likes/dwell.
 *
 * Root fix for stats.json read-modify-write races: all mutations are serialized
 * on one Durable Object instance via an in-isolate promise queue, so concurrent
 * track/like/dwell requests no longer lose updates.
 *
 * Storage schema v2 (one small key per concern, no monolithic map):
 * - `s:<slug>`          per-post counters (+ optional category/tags for traffic)
 * - `day:<YYYY-MM-DD>`  per-day view counters (30-day traffic chart)
 * - `agg`               slug registry: { slugs: [...], updatedAt }
 * - `meta`              { schema: 2, migratedAt, legacyUntil }
 *
 * No R2 writes on the hot path: the pre-v2 `site-data/stats.json` object is read
 * exactly once as a migration seed and then deleted. The legacy in-storage map
 * (`stats`) is migrated once and kept for 30 days as a rollback path.
 *
 * Per-IP view dedupe lives in DO memory only (it is a cache, not a source of
 * truth), so it never inflates storage writes.
 */

const LEGACY_KEY = 'stats';
const META_KEY = 'meta';
const AGG_KEY = 'agg';
const SCHEMA = 2;
const SLUG_PREFIX = 's:';
const DAY_PREFIX = 'day:';
const LEGACY_RETENTION_MS = 30 * 864e5;
const MAX_HISTORY = 500;
const DEDUP_MS = 10 * 60 * 1000;
const DEDUP_MAX_PER_SLUG = 2000;
const MAX_DWELL = 7200;
const TRAFFIC_CACHE_MS = 30 * 1000;
const MAX_STATS_SLUGS = 5000;
const MAX_SLUG_LENGTH = 120;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
      while (_trackCounts.size > TRACK_MAP_MAX / 2) _trackCounts.delete(_trackCounts.keys().next().value);
    }
    _trackCounts.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > TRACK_LIMIT;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Tracked slugs must be plain path segments: bounded length, no separators, no
 * control characters, never `.`/`..`.
 */
export function validStatsSlug(slug) {
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

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeEntry(raw) {
  const value = typeof raw === 'number' ? { views: raw } : raw && typeof raw === 'object' ? raw : {};
  const entry = {
    views: toCount(value.views ?? value.count),
    likes: toCount(value.likes),
    dwell_time: toCount(value.dwell_time),
  };
  // category/tags are only present on entries migrated from the legacy map; new
  // views cannot know them, so they are optional.
  if (typeof value.category === 'string' && value.category) entry.category = value.category;
  if (Array.isArray(value.tags) && value.tags.length) entry.tags = value.tags.map(String);
  return entry;
}

/** Last 30 UTC days, oldest first, as the traffic chart expects. */
function recentDays(now = Date.now()) {
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(new Date(now - i * 864e5).toISOString().slice(0, 10));
  return days;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export class StatsDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._queue = Promise.resolve();
    this._loaded = false;
    this._meta = null;
    this._slugs = [];
    this._slugSet = new Set();
    this._entries = new Map();
    this._days = new Map();
    this._daysLoaded = false;
    this._traffic = null;
    this._trafficAt = 0;
    // In-memory dedupe: slug -> Map(ip -> timestamp). Never persisted.
    this._recent = new Map();
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
    // All mutations/reads run through one queue: concurrent track requests to the
    // same DO instance must not interleave read-modify-write sequences.
    return this._mutate(() => this._handle(path, slug, body, ip));
  }

  async _handle(path, slug, body, ip) {
    const needsSlug = path !== '/traffic' && path !== '/bulk';
    if (needsSlug && !slug) return json({ error: 'slug required', code: 'INVALID_PARAMS' }, 400);
    if (needsSlug && !validStatsSlug(slug)) return json({ error: 'Invalid slug', code: 'INVALID_PARAMS' }, 400);

    try {
      if (path === '/view') return json({ ok: true, ...(await this._view(slug, ip)) });
      if (path === '/like') {
        const action = body.action === 'unlike' || body.action === 'down' ? -1 : 1;
        return json({ ok: true, ...(await this._like(slug, action)) });
      }
      if (path === '/dwell') {
        const seconds = Math.min(Math.max(parseInt(body.seconds) || 0, 0), MAX_DWELL);
        return json({ ok: true, dwell_time: await this._dwell(slug, seconds) });
      }
      if (path === '/stats') return json(await this._stats(slug));
      if (path === '/traffic') return json(await this._trafficReport());
      if (path === '/bulk') return json(await this._bulk());
    } catch (error) {
      console.error('StatsDurableObject error:', error?.message || error);
      return json({ error: 'Internal stats error', code: 'STATS_ERROR' }, 500);
    }
    return json({ error: 'Not found' }, 404);
  }

  // ── Loading + migration ──
  async _load() {
    if (this._loaded) return;
    const meta = await this.state.storage.get(META_KEY);
    if (meta?.schema === SCHEMA) {
      this._meta = meta;
      const agg = (await this.state.storage.get(AGG_KEY)) || {};
      this._slugs = Array.isArray(agg.slugs) ? agg.slugs.filter(validStatsSlug).slice(0, MAX_STATS_SLUGS) : [];
      this._slugSet = new Set(this._slugs);
      this._loaded = true;
      await this._expireLegacy(meta);
      return;
    }
    await this._migrate();
  }

  async _expireLegacy(meta) {
    if (!meta?.legacyUntil || Date.now() <= Date.parse(meta.legacyUntil)) return;
    // The rollback copy is past its 30-day window: drop it lazily.
    try {
      if (typeof this.state.storage.delete === 'function') await this.state.storage.delete(LEGACY_KEY);
      this._meta = { ...meta, legacyUntil: '' };
      await this.state.storage.put(META_KEY, this._meta);
    } catch {}
  }

  async _migrate() {
    let legacy = await this.state.storage.get(LEGACY_KEY);
    if (!legacy || typeof legacy !== 'object' || !Object.keys(legacy).length) {
      // One-time R2 seed for counters that predate the Durable Object.
      try {
        const object = await this.env?.MEDIA?.get?.('site-data/stats.json');
        if (object) legacy = JSON.parse(await object.text());
      } catch {
        legacy = null;
      }
    }
    const entries = new Map();
    const days = new Map();
    const slugs = [];
    for (const [slug, raw] of Object.entries(legacy && typeof legacy === 'object' ? legacy : {})) {
      if (!validStatsSlug(slug)) continue;
      if (slugs.length >= MAX_STATS_SLUGS) break;
      const entry = normalizeEntry(raw);
      entries.set(slug, entry);
      slugs.push(slug);
      const history = Array.isArray(raw?.history) ? raw.history.slice(-MAX_HISTORY) : [];
      for (const timestamp of history) {
        const day = String(timestamp).slice(0, 10);
        if (DAY_RE.test(day)) days.set(day, (days.get(day) || 0) + 1);
      }
    }
    for (const [slug, entry] of entries) await this.state.storage.put(SLUG_PREFIX + slug, entry);
    for (const [day, count] of days) await this.state.storage.put(DAY_PREFIX + day, count);
    const meta = {
      schema: SCHEMA,
      migratedAt: new Date().toISOString(),
      legacyUntil: new Date(Date.now() + LEGACY_RETENTION_MS).toISOString(),
    };
    await this.state.storage.put(AGG_KEY, { slugs, updatedAt: new Date().toISOString() });
    await this.state.storage.put(META_KEY, meta);
    this._meta = meta;
    this._slugs = slugs;
    this._slugSet = new Set(slugs);
    this._entries = entries;
    this._days = days;
    this._daysLoaded = true;
    this._loaded = true;
    // Stop writing the R2 mirror: the seed has been imported into DO storage.
    try {
      if (typeof this.env?.MEDIA?.delete === 'function') await this.env.MEDIA.delete('site-data/stats.json');
    } catch {}
  }

  // ── Per-key helpers ──
  async _entry(slug) {
    if (this._entries.has(slug)) return { entry: this._entries.get(slug), fresh: false };
    const stored = await this.state.storage.get(SLUG_PREFIX + slug);
    const entry = normalizeEntry(stored);
    this._entries.set(slug, entry);
    return { entry, fresh: true };
  }

  async _persistEntry(slug, entry) {
    this._entries.set(slug, entry);
    await this.state.storage.put(SLUG_PREFIX + slug, entry);
  }

  async _registerSlug(slug) {
    if (this._slugSet.has(slug)) return;
    if (this._slugs.length >= MAX_STATS_SLUGS) return;
    this._slugSet.add(slug);
    this._slugs.push(slug);
    await this.state.storage.put(AGG_KEY, { slugs: this._slugs, updatedAt: new Date().toISOString() });
  }

  /** Today's persisted view count, loaded lazily into the in-memory day map. */
  async _day(day) {
    if (this._days.has(day)) return this._days.get(day);
    const stored = await this.state.storage.get(DAY_PREFIX + day);
    const count = toCount(stored);
    this._days.set(day, count);
    return count;
  }

  async _ensureDays() {
    if (this._daysLoaded) return;
    for (const day of recentDays()) await this._day(day);
    this._daysLoaded = true;
  }

  _dedupCounted(slug, ip) {
    const now = Date.now();
    let ips = this._recent.get(slug);
    if (!ips) {
      ips = new Map();
      this._recent.set(slug, ips);
    }
    const last = ips.get(ip);
    if (last && now - last < DEDUP_MS) return false;
    ips.set(ip, now);
    if (ips.size > DEDUP_MAX_PER_SLUG) {
      for (const [key, at] of ips) if (now - at > DEDUP_MS) ips.delete(key);
      while (ips.size > DEDUP_MAX_PER_SLUG / 2) ips.delete(ips.keys().next().value);
    }
    return true;
  }

  // ── Mutations ──
  async _view(slug, ip) {
    await this._load();
    await this._registerSlug(slug);
    const { entry } = await this._entry(slug);
    if (!this._dedupCounted(slug, ip)) return { views: entry.views, likes: entry.likes, dedup: true };
    entry.views += 1;
    const day = new Date().toISOString().slice(0, 10);
    const dayCount = (await this._day(day)) + 1;
    this._days.set(day, dayCount);
    await Promise.all([this.state.storage.put(DAY_PREFIX + day, dayCount), this._persistEntry(slug, entry)]);
    this._invalidateTraffic();
    return { views: entry.views, likes: entry.likes };
  }

  async _like(slug, delta) {
    await this._load();
    await this._registerSlug(slug);
    const { entry } = await this._entry(slug);
    entry.likes = Math.max(0, entry.likes + delta);
    await this._persistEntry(slug, entry);
    this._invalidateTraffic();
    return { likes: entry.likes, views: entry.views };
  }

  async _dwell(slug, seconds) {
    await this._load();
    await this._registerSlug(slug);
    const { entry } = await this._entry(slug);
    entry.dwell_time = Math.max(entry.dwell_time || 0, seconds);
    await this._persistEntry(slug, entry);
    return entry.dwell_time;
  }

  // ── Reads ──
  async _stats(slug) {
    await this._load();
    const { entry } = await this._entry(slug);
    return { slug, views: entry.views, likes: entry.likes, dwell_time: entry.dwell_time };
  }

  _invalidateTraffic() {
    this._traffic = null;
    this._trafficAt = 0;
  }

  /**
   * Site traffic report. Field-for-field compatible with the pre-v2 aggregate:
   * `{ total, totalLikes, posts, byDay, byCategory, byTag, top5 }`.
   */
  async _trafficReport() {
    if (this._traffic && Date.now() - this._trafficAt < TRAFFIC_CACHE_MS) return this._traffic;
    await this._load();
    await this._ensureDays();
    const byCategory = new Map();
    const byTag = new Map();
    const entries = [];
    let total = 0;
    let totalLikes = 0;
    for (const slug of this._slugs) {
      const { entry } = await this._entry(slug);
      total += entry.views;
      totalLikes += entry.likes;
      entries.push({ slug, count: entry.views, likes: entry.likes });
      const topCategory =
        String(entry.category || '')
          .split('/')[0]
          .trim() || 'uncategorized';
      byCategory.set(topCategory, (byCategory.get(topCategory) || 0) + entry.views);
      for (const tag of entry.tags || []) byTag.set(tag, (byTag.get(tag) || 0) + entry.views);
    }
    entries.sort((a, b) => b.count - a.count);
    const report = {
      total,
      totalLikes,
      posts: entries.length,
      byDay: recentDays().map((date) => ({ date, count: this._days.get(date) || 0 })),
      byCategory: [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      byTag: [...byTag.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({ name, count })),
      top5: entries.slice(0, 5).map((entry) => ({ slug: entry.slug, count: entry.count, likes: entry.likes })),
    };
    this._traffic = report;
    this._trafficAt = Date.now();
    return report;
  }

  /** All per-post counters in one round-trip (replaces the 500-call fan-out). */
  async _bulk() {
    await this._load();
    const stats = {};
    for (const slug of this._slugs) {
      const { entry } = await this._entry(slug);
      stats[slug] = { views: entry.views, likes: entry.likes, dwell_time: entry.dwell_time };
    }
    return { stats, updatedAt: new Date().toISOString() };
  }

  /** Serialize mutations so concurrent track requests cannot lose updates. */
  _mutate(fn) {
    const run = async () => fn();
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }
}
