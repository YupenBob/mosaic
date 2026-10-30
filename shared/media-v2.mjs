/**
 * Media v2 primitives: independent asset identities, v2 manifest validation,
 * R2 key layout and post→asset references.
 *
 * This module is deliberately pure and additive. The live v1 path keeps using
 * `shared/media-manifest.mjs` until the Worker, build and admin have all been
 * migrated; both schemas can then be read side by side.
 */

export const ASSET_SCHEMA_VERSION = 2;
export const ASSET_ID_PREFIX = 'ast_';
export const ASSET_ID_RE = /^ast_[a-z0-9]{26,64}$/;
export const FOLDERS = ['photos', 'videos', 'music', 'covers', 'others'];
export const STATUSES = ['pending', 'running', 'ready', 'failed', 'cancelled', 'superseded', 'deleted'];

const UNSAFE_SEGMENT = /["'`<>\\\u2028\u2029]/;

/** Same identity rules as v1; exported here so v2 does not depend on v1 internals. */
export function validAssetFilename(value) {
  return (
    typeof value === 'string' &&
    !!value &&
    !/[\/\\]/.test(value) &&
    !UNSAFE_SEGMENT.test(value) &&
    !['.', '..'].includes(value)
  );
}

/** Crockford-ish random id, 26 lowercase base32 characters after the prefix. */
export function newAssetId() {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  let id = ASSET_ID_PREFIX;
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

/** Deterministic id for migrating a legacy `slug/folder/filename` asset. */
export async function assetIdFromLegacy(legacyId) {
  const data = new TextEncoder().encode(String(legacyId));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  return (
    ASSET_ID_PREFIX +
    [...new Uint8Array(digest)]
      .map((byte) => alphabet[byte % alphabet.length])
      .join('')
      .slice(0, 26)
  );
}

export function originalKey(asset) {
  return `originals/assets/${asset.id}/${asset.filename}`;
}

export function processedPrefix(asset, generation = asset.generation) {
  return `processed/assets/${asset.id}/${generation}`;
}

export function processedKey(asset, generation, filename) {
  return `${processedPrefix(asset, generation)}/${filename}`;
}

export function emptyAssetManifest() {
  return { schemaVersion: ASSET_SCHEMA_VERSION, revision: 0, assets: {}, usageRevision: 0 };
}

function validOptionalKey(value, expectedPrefix) {
  return value === undefined || value === null || (typeof value === 'string' && value.startsWith(expectedPrefix));
}

/**
 * Validate a v2 manifest without touching v1. Throws on corrupt data; callers
 * can fall back to the v1 validator during the dual-read window.
 */
export function validateAssetManifest(value) {
  if (value?.schemaVersion !== ASSET_SCHEMA_VERSION) throw new Error('Unsupported media manifest schema (expected v2)');
  if (!Number.isInteger(value.revision) || value.revision < 0) throw new Error('Invalid media manifest revision');
  if (!value.assets || Array.isArray(value.assets)) throw new Error('Invalid media manifest assets');
  for (const [id, asset] of Object.entries(value.assets)) {
    if (!ASSET_ID_RE.test(id) || asset.id !== id) throw new Error(`Invalid asset id: ${id}`);
    if (!validAssetFilename(asset.filename)) throw new Error(`Invalid asset filename: ${id}`);
    if (!FOLDERS.includes(asset.folder)) throw new Error(`Invalid asset folder: ${id}`);
    if (!Number.isInteger(asset.generation) || asset.generation < 0) throw new Error(`Invalid asset generation: ${id}`);
    if (!STATUSES.includes(asset.status)) throw new Error(`Invalid asset status: ${id}`);
    if (!asset.source || asset.source.key !== originalKey(asset)) throw new Error(`Invalid asset source key: ${id}`);
    if (asset.published) {
      const prefix = processedPrefix(asset, asset.published.generation ?? asset.generation) + '/';
      for (const key of Object.values(asset.published.variants || {}))
        if (!validOptionalKey(key, prefix)) throw new Error(`Invalid published variant for ${id}`);
      for (const key of ['poster', 'posterPreview', 'placeholder', 'hls'])
        if (!validOptionalKey(asset.published[key], prefix)) throw new Error(`Invalid ${key} for ${id}`);
      for (const key of Object.values(asset.published.sources || {}))
        if (!validOptionalKey(key, prefix)) throw new Error(`Invalid source variant for ${id}`);
    }
    if (asset.legacy && asset.legacy.id !== undefined && typeof asset.legacy.id !== 'string')
      throw new Error(`Invalid legacy mapping: ${id}`);
  }
  return value;
}

/**
 * Normalize the frontmatter `media` block. The body keeps using
 * `{{photo:N}}` / `{{video:N}}`, so authoring does not have to learn asset ids.
 */
export function normalizePostMedia(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const list = (input) =>
    Array.isArray(input) ? input.filter((id) => typeof id === 'string' && ASSET_ID_RE.test(id)) : [];
  return {
    gallery: list(source.gallery),
    videos: list(source.videos),
    music: list(source.music),
    cover: typeof source.cover === 'string' && source.cover ? source.cover : null,
  };
}

/** All asset ids referenced by one post, including the cover when it is an id. */
export function postAssetIds(media) {
  const normalized = normalizePostMedia(media);
  const ids = [...normalized.gallery, ...normalized.videos, ...normalized.music];
  if (normalized.cover && ASSET_ID_RE.test(normalized.cover)) ids.push(normalized.cover);
  return [...new Set(ids)];
}

/**
 * Build `site-data/asset-usage.json` from posts (published and drafts).
 * @param {Array<{slug:string, media?:object, kind?:string}>} posts
 */
export function buildAssetUsage(posts) {
  const assets = {};
  for (const post of posts || []) {
    const kind = post.kind === 'draft' ? 'draft' : 'published';
    const media = normalizePostMedia(post.media);
    for (const [role, ids] of Object.entries({ gallery: media.gallery, videos: media.videos, music: media.music }))
      ids.forEach((id, order) => {
        (assets[id] ||= []).push({
          slug: post.slug,
          ...(post.draftId ? { draftId: post.draftId } : {}),
          kind,
          role,
          order,
        });
      });
    if (media.cover && ASSET_ID_RE.test(media.cover))
      (assets[media.cover] ||= []).push({
        slug: post.slug,
        ...(post.draftId ? { draftId: post.draftId } : {}),
        kind,
        role: 'cover',
        order: 0,
      });
  }
  return { revision: 0, assets };
}
