/**
 * Media v2 primitives: independent ids, R2 layout, manifest validation and
 * post→asset usage. v1 remains untouched and is validated by its own module.
 */
import assert from 'node:assert/strict';
import {
  ASSET_ID_RE,
  assetIdFromLegacy,
  buildAssetUsage,
  emptyAssetManifest,
  newAssetId,
  normalizePostMedia,
  originalKey,
  postAssetIds,
  processedKey,
  validateAssetManifest,
} from '../shared/media-v2.mjs';
import { emptyManifest, validateManifest } from '../shared/media-manifest.mjs';

const id = newAssetId();
assert.match(id, ASSET_ID_RE);
assert.equal(newAssetId() === newAssetId(), false);
const migrated = await assetIdFromLegacy('autumn-light/videos/clip.mp4');
assert.equal(migrated, await assetIdFromLegacy('autumn-light/videos/clip.mp4'), 'migration ids are deterministic');
assert.match(migrated, ASSET_ID_RE);

const asset = {
  id,
  filename: 'clip.mp4',
  folder: 'videos',
  generation: 2,
  status: 'ready',
  source: { key: `originals/assets/${id}/clip.mp4`, etag: 'etag', available: true },
  published: {
    generation: 2,
    variants: { '480p': `processed/assets/${id}/2/480p.mp4` },
    sources: { '480p': `processed/assets/${id}/2/480p.mp4` },
    poster: `processed/assets/${id}/2/poster.jpg`,
  },
};
assert.equal(originalKey(asset), asset.source.key);
assert.equal(processedKey(asset, 2, '480p.mp4'), asset.published.variants['480p']);

const manifest = emptyAssetManifest();
manifest.assets[id] = asset;
validateAssetManifest(manifest);
assert.equal(manifest.schemaVersion, 2);

const bad = structuredClone(manifest);
bad.assets[id].source.key = `originals/autumn-light/videos/clip.mp4`;
assert.throws(() => validateAssetManifest(bad), /source key/);
const badStatus = structuredClone(manifest);
badStatus.assets[id].status = 'weird';
assert.throws(() => validateAssetManifest(badStatus), /status/);
const badVariant = structuredClone(manifest);
badVariant.assets[id].published.poster = 'processed/other/poster.jpg';
assert.throws(() => validateAssetManifest(badVariant), /poster/);
const badName = structuredClone(manifest);
badName.assets[id].filename = `x');alert(1)//`;
assert.throws(() => validateAssetManifest(badName), /filename/);

// v1 keeps validating exactly as before.
const v1 = emptyManifest();
v1.assets['post/photos/a.jpg'] = {
  id: 'post/photos/a.jpg',
  slug: 'post',
  filename: 'a.jpg',
  folder: 'photos',
  status: 'ready',
};
validateManifest(v1);

const media = normalizePostMedia({
  gallery: [id, 'not-an-id'],
  videos: [],
  music: [],
  cover: id,
});
assert.deepEqual(media, { gallery: [id], videos: [], music: [], cover: id });
assert.deepEqual(postAssetIds(media), [id]);

const usage = buildAssetUsage([
  { slug: 'post', media: { gallery: [id], cover: id } },
  { slug: 'post', draftId: 'draft-1', kind: 'draft', media: { gallery: [id] } },
]);
assert.equal(usage.assets[id].length, 3);
assert.deepEqual(
  usage.assets[id].map((entry) => [entry.kind, entry.role]),
  [
    ['published', 'gallery'],
    ['published', 'cover'],
    ['draft', 'gallery'],
  ],
);

console.log('Media v2 smoke: ids, keys, manifest, post refs and usage passed');
