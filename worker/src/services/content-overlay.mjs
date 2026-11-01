/**
 * Content overlay — Worker-side content edits layered on top of the build-time
 * `site-data/posts-index.json`.
 *
 * Before the overlay every admin write set a dirty flag and `listPosts()` fell
 * back to reading every `content/posts/<slug>/index.md` from GitHub (N+1 calls
 * for a single list render). Now the write paths record the changed posts here:
 *
 *   {
 *     schema: 1,
 *     revision: 7,
 *     updatedAt: '…',
 *     upserts: { '<slug>': <post record> },   // added or changed posts
 *     removes: { '<slug>': '…' },             // deleted posts
 *     refresh: false                          // true = overlay cannot describe
 *                                             // the change (non-post file edits)
 *   }
 *
 * `listPosts()` merges the overlay over the R2 index. The overlay is deleted
 * once the build that includes the changes has been published, so it stays a
 * small delta. Writes are compare-and-set on the R2 object ETag (three
 * attempts), which keeps concurrent saves from losing each other's changes.
 */
import { cacheFor } from './github-client.js';
import { validSegment } from '../../../shared/media-manifest.mjs';
import { isValidTaxonomyName } from '../../../shared/taxonomy.mjs';

export const CONTENT_OVERLAY_KEY = 'site-data/content-overlay.json';
export const CONTENT_OVERLAY_SCHEMA = 1;
export const CONTENT_OVERLAY_CACHE_MS = 5000;
export const CONTENT_OVERLAY_WRITE_RETRIES = 3;

const overlayCache = new WeakMap();

export function emptyContentOverlay() {
  return { schema: CONTENT_OVERLAY_SCHEMA, revision: 0, updatedAt: '', upserts: {}, removes: {}, refresh: false };
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A record is only consumed when its identity and taxonomy fields are safe:
 * the overlay is what the admin list and the next build read, so an entry that
 * bypassed schema validation must never be merged. Invalid entries flip the
 * overlay to `refresh`, which makes listPosts read the authoritative Git state.
 */
function isConsumableRecord(slug, record) {
  if (!validSegment(slug)) return false;
  if (record.category != null && !isValidTaxonomyName(record.category, { kind: 'category' })) return false;
  if (record.tags != null) {
    if (!Array.isArray(record.tags)) return false;
    if (record.tags.some((tag) => !isValidTaxonomyName(tag, { kind: 'tag' }))) return false;
  }
  return true;
}

/** Defensive shape normalisation: a corrupt overlay must never break listPosts. */
export function normalizeContentOverlay(value) {
  if (!isRecord(value)) return emptyContentOverlay();
  let refresh = value.refresh === true;
  const upserts = {};
  for (const [slug, record] of Object.entries(isRecord(value.upserts) ? value.upserts : {})) {
    if (typeof slug !== 'string' || !slug || !isRecord(record)) continue;
    if (!isConsumableRecord(slug, record)) {
      refresh = true;
      continue;
    }
    upserts[slug] = record;
  }
  const removes = {};
  for (const [slug, timestamp] of Object.entries(isRecord(value.removes) ? value.removes : {}))
    if (typeof slug === 'string' && slug) removes[slug] = typeof timestamp === 'string' ? timestamp : '';
  return {
    schema: CONTENT_OVERLAY_SCHEMA,
    revision: Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    upserts,
    removes,
    refresh,
  };
}

/**
 * Merge an overlay over a list of post records (listPosts shape).
 * - removes win over the base list
 * - upserts replace the base record field-by-field (a partial record is fine)
 * - new posts are inserted in date order (the index is newest-first)
 */
export function applyContentOverlay(basePosts, overlay) {
  const posts = Array.isArray(basePosts) ? basePosts : [];
  if (!overlay) return posts.slice();
  const removes = new Set(Object.keys(overlay.removes || {}));
  const upserts = overlay.upserts || {};
  const merged = [];
  const seen = new Set();
  for (const post of posts) {
    if (!post || typeof post.slug !== 'string') continue;
    seen.add(post.slug);
    if (removes.has(post.slug)) continue;
    const override = upserts[post.slug];
    merged.push(override ? { ...post, ...override, slug: post.slug } : post);
  }
  for (const [slug, override] of Object.entries(upserts)) {
    if (seen.has(slug) || removes.has(slug)) continue;
    merged.push({ ...override, slug });
  }
  // The build index is newest-first; keep that order after inserts.
  return merged.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

/** Drop cached overlay + composed post list so the next read sees the write. */
export function invalidateContentOverlay(env) {
  overlayCache.delete(env);
  const cache = cacheFor(env);
  cache.posts = null;
  cache.postsTime = 0;
}

/** Read the raw overlay plus its ETag (uncached — used by CAS writes). */
export async function readContentOverlayRaw(env) {
  const object = await env.MEDIA.get(CONTENT_OVERLAY_KEY);
  if (!object) return { overlay: emptyContentOverlay(), etag: null, exists: false };
  try {
    return {
      overlay: normalizeContentOverlay(JSON.parse(await object.text())),
      etag: object.etag || null,
      exists: true,
    };
  } catch {
    // Corrupt overlay: treat as empty and overwrite it on the next write.
    return { overlay: emptyContentOverlay(), etag: null, exists: true };
  }
}

/** Read + 5s memory cache for the read path (listPosts). */
export async function readContentOverlay(c) {
  const env = c.env;
  const cached = overlayCache.get(env);
  if (cached && Date.now() - cached.at < CONTENT_OVERLAY_CACHE_MS) return cached.overlay;
  const raw = await readContentOverlayRaw(env);
  // `null` means "no overlay object exists yet" (as opposed to an empty overlay
  // that the build already cleared) — listPosts treats those differently.
  const overlay = raw.exists ? raw.overlay : null;
  overlayCache.set(env, { overlay, at: Date.now() });
  return overlay;
}

/**
 * Apply a mutation with optimistic concurrency: re-read the overlay, mutate a
 * copy, write back only if the ETag still matches, retry up to three times.
 */
async function mutateContentOverlay(env, mutate) {
  for (let attempt = 0; attempt < CONTENT_OVERLAY_WRITE_RETRIES; attempt++) {
    const { overlay, etag } = await readContentOverlayRaw(env);
    const next = normalizeContentOverlay({
      ...overlay,
      upserts: { ...overlay.upserts },
      removes: { ...overlay.removes },
    });
    mutate(next);
    next.schema = CONTENT_OVERLAY_SCHEMA;
    next.revision = overlay.revision + 1;
    next.updatedAt = new Date().toISOString();
    const options = { httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } };
    if (etag) options.onlyIf = { etagMatches: etag };
    let stored;
    try {
      stored = await env.MEDIA.put(CONTENT_OVERLAY_KEY, JSON.stringify(next), options);
    } catch {
      stored = null;
    }
    // R2 returns null when the ETag precondition fails; undefined comes from
    // simplified test doubles and means "written".
    if (stored !== null) {
      invalidateContentOverlay(env);
      return next;
    }
    if (attempt < CONTENT_OVERLAY_WRITE_RETRIES - 1)
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
  }
  throw Object.assign(new Error('Content overlay write conflict'), { status: 409, code: 'CONFLICT' });
}

/** Record one or more saved posts (idempotent; last write wins per slug). */
export async function upsertContentOverlay(c, posts) {
  const list = (Array.isArray(posts) ? posts : [posts]).filter(
    (post) => post && typeof post.slug === 'string' && post.slug,
  );
  if (!list.length) return null;
  return mutateContentOverlay(c.env, (overlay) => {
    for (const post of list) {
      const { slug, ...record } = post;
      overlay.upserts[slug] = record;
      delete overlay.removes[slug];
    }
  });
}

/** Record one or more deleted posts. */
export async function removeFromContentOverlay(c, slugs) {
  const list = (Array.isArray(slugs) ? slugs : [slugs]).filter((slug) => typeof slug === 'string' && slug);
  if (!list.length) return null;
  return mutateContentOverlay(c.env, (overlay) => {
    const now = new Date().toISOString();
    for (const slug of list) {
      delete overlay.upserts[slug];
      overlay.removes[slug] = now;
    }
  });
}

/**
 * Mark the overlay as unable to describe the pending changes (e.g. a restored
 * commit that touched config/media instead of post Markdown). listPosts then
 * falls back to the authoritative GitHub read until the next build clears it.
 */
export async function markContentOverlayRefresh(c) {
  return mutateContentOverlay(c.env, (overlay) => {
    overlay.refresh = true;
  });
}

/** Delete the overlay (called after a successful build/deploy). */
export async function clearContentOverlay(env) {
  try {
    await env.MEDIA.delete(CONTENT_OVERLAY_KEY);
  } catch (error) {
    console.error('clearContentOverlay: delete failed', error?.message || error);
  }
  invalidateContentOverlay(env);
}
