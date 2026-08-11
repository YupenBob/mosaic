/**
 * Shared helpers for the Mosaic Worker API: version, CORS policy, fire-and-forget
 * scheduling, the Stats Durable Object client, and parallel R2 traversal utils.
 */
import { readUsageSnapshot, writeUsageSnapshot, invalidateUsageSnapshot } from './usage.js';

export const VERSION = '1.0.0';
export const HEALTH_TIMEOUT_MS = 5000;

// ── CORS ──
export const PUBLIC_CORS_PREFIXES = ['/api/health', '/api/stats/', '/api/track/', '/api/media/'];
export const DEFAULT_ALLOWED_ORIGINS = 'https://mosaic-admin.xsanye.cn';

export function isPublicPath(path) {
  return PUBLIC_CORS_PREFIXES.some((p) => path.startsWith(p));
}

// Run a fire-and-forget task; executionCtx only exists in Workers runtimes.
export function defer(c, fn) {
  try {
    const ctx = c.executionCtx;
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(fn());
      return;
    }
  } catch {}
  fn();
}

// Stats are served by the StatsDurableObject (single instance, serialized writes).
function statsURL(path, slug) {
  return new URL(`https://stats.local${path}${slug ? '?slug=' + encodeURIComponent(slug) : ''}`);
}

// Classic Durable Object namespace access (idFromName -> get -> stub.fetch)
export async function statsFetch(c, path, slug, init = {}) {
  const id = c.env.STATS.idFromName('global');
  const stub = c.env.STATS.get(id);
  return stub.fetch(statsURL(path, slug), init);
}

// ── Parallel R2 traversal ──
// R2 list cursors are sequential per prefix, but top-level prefixes are
// independent, so scanning originals/ + processed/ + site-data/ in parallel
// cuts full-bucket traversals (disk/cleanup) to ~1/3 of wall time.
async function bucketUsage(env) {
  const parts = await Promise.all(
    ['originals/', 'processed/', 'site-data/'].map(async (prefix) => {
      let size = 0,
        objects = 0,
        cursor;
      do {
        const opts = { prefix, limit: 1000 };
        if (cursor) opts.cursor = cursor;
        const list = await env.MEDIA.list(opts);
        for (const obj of list.objects || []) {
          size += obj.size;
          objects++;
        }
        cursor = list.truncated ? list.cursor : null;
      } while (cursor);
      return { size, objects };
    }),
  );
  return {
    size: parts.reduce((a, b) => a + b.size, 0),
    objects: parts.reduce((a, b) => a + b.objects, 0),
  };
}

let _diskCache = null,
  _diskAt = 0;
const DISK_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function getDiskUsage(env) {
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

export async function scanOrphans(env, valid, mode) {
  const parts = await Promise.all(
    ['originals/', 'processed/'].map(async (prefix) => {
      let orphans = [],
        freed = 0,
        deleted = 0,
        cursor;
      do {
        const opts = { prefix, limit: 1000 };
        if (cursor) opts.cursor = cursor;
        const list = await env.MEDIA.list(opts);
        for (const o of list.objects || []) {
          const slug = o.key.split('/')[1];
          if (!slug || valid.has(slug)) continue;
          if (mode === 'delete') {
            await env.MEDIA.delete(o.key);
            deleted++;
            freed += o.size;
          } else orphans.push({ key: o.key, size: o.size });
        }
        cursor = list.truncated ? list.cursor : null;
      } while (cursor);
      return { orphans, freed, deleted };
    }),
  );
  const total = parts.reduce(
    (acc, p) => ({
      orphans: acc.orphans.concat(p.orphans),
      freed: acc.freed + p.freed,
      deleted: acc.deleted + p.deleted,
    }),
    { orphans: [], freed: 0, deleted: 0 },
  );
  if (mode === 'delete' && total.deleted > 0) await invalidateUsageSnapshot(env);
  return total;
}
