/**
 * Media v2 asset registration: independent ids, mixed manifest, list/delete and
 * v1 coexistence. Uses the in-memory Jobs DO runtime.
 */
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';
import { newAssetId } from '../shared/media-v2.mjs';
import { validateManifest } from '../shared/media-manifest.mjs';
import { processedPrefixFor } from '../scripts/media/run.mjs';
import { resolveMedia } from '../scripts/site/media.mjs';

const runtime = createRuntime();
const id = newAssetId();
const task = await runtime.enqueueAsset('clip.mp4', Buffer.from('v2-source'), { id });
assert.equal(task.status, 'pending');
assert.ok(task.taskId);

const listed = await runtime.call('assets-list', {});
assert.equal(listed.total, 1);
assert.equal(listed.assets[0].id, id);
assert.equal(listed.assets[0].v2, true);
assert.equal(listed.assets[0].published, false);
assert.equal(listed.assets[0].sourceAvailable, true);
assert.equal(listed.assets[0].lifecycle.state, 'processing');
assert.equal(listed.assets[0].lifecycle.health.level, 'ok');

const state = await runtime.call('state');
validateManifest(state.manifest);
assert.equal(state.manifest.schemaVersion, 2, 'v2 registration upgrades the mixed manifest');
assert.equal(state.manifest.assets[id].slug, null);
assert.equal(state.manifest.assets[id].source.key, `originals/assets/${id}/clip.mp4`);

// v1 assets still register and stay out of the v2 asset list.
await runtime.enqueue('legacy-post', 'photo.jpg');
const afterV1 = await runtime.call('assets-list', {});
assert.equal(afterV1.total, 1, 'v1 assets do not leak into the v2 library');
const legacy = await runtime.call('media-list', { slug: 'legacy-post' });
assert.equal(legacy.length, 1, 'legacy slug list still sees its own asset');
assert.equal(legacy[0].id, 'legacy-post/photos/photo.jpg', 'v2 assets do not leak into a legacy slug list');

// Claim + publish exercises the v2 R2 prefix and publish-key validation.
const claimed = await runtime.call('claim', { runId: 'run-asset' });
assert.equal(claimed.job.assetId, id);
assert.equal(processedPrefixFor(claimed.job), `processed/assets/${id}/${claimed.job.generation}`);
await runtime.bucket.put(`processed/assets/${id}/${claimed.job.generation}/480p.mp4`, 'encoded');
await runtime.call('publish', {
  id: claimed.job.id,
  token: claimed.job.token,
  runId: 'run-asset',
  published: { variants: { '480p': `processed/assets/${id}/${claimed.job.generation}/480p.mp4` } },
  complete: false,
});
const publishedState = await runtime.call('state');
assert.ok(publishedState.manifest.assets[id].published.variants['480p']);
assert.equal(publishedState.manifest.assets[id].status, 'processing');
assert.equal(publishedState.manifest.assets[id].lifecycle.lastPublishedAt !== null, true);
await runtime.call('failed', {
  id: claimed.job.id,
  token: claimed.job.token,
  runId: 'run-asset',
  error: 'fixture encode failure',
});
const degraded = await runtime.call('assets-list', {});
assert.equal(degraded.assets[0].lifecycle.state, 'degraded');
assert.ok(degraded.assets[0].lifecycle.health.reasons.includes('latest-job-failed'));

const deleted = await runtime.call('delete-assets', { ids: [id] });
assert.equal(deleted.ok, true);
const afterDelete = await runtime.call('assets-list', {});
assert.equal(afterDelete.total, 0, 'soft-deleted assets disappear from the default list');
const withDeleted = await runtime.call('assets-list', { includeDeleted: true });
assert.equal(withDeleted.total, 1);
assert.equal(withDeleted.assets[0].lifecycle.state, 'deleting');
assert.ok(withDeleted.assets[0].lifecycle.purgeAfter);

const restoredAsset = await runtime.call('restore-assets', { ids: [id] });
assert.equal(restoredAsset.ok, true);
const afterRestore = await runtime.call('assets-list', {});
assert.equal(afterRestore.total, 1, 'restore brings the asset back before purge');
assert.equal(afterRestore.assets[0].lifecycle.state, 'degraded');

await runtime.call('delete-assets', { ids: [id], soft: false });
const hardDeleted = await runtime.call('assets-list', { includeDeleted: true });
assert.equal(hardDeleted.assets[0].status, 'deleted');

// Restarting the coordinator must preserve the mixed manifest.
runtime.restart();
const restored = await runtime.call('assets-list', { includeDeleted: true });
assert.equal(restored.total, 1);
validateManifest((await runtime.call('state')).manifest);

console.log('Media assets: v2 registration, mixed manifest, list/delete and restart passed');

// Build-time resolution: a post references v2 assets by id, while the body
// keeps using photo:N / video:N placeholders.
const buildManifest = {
  schemaVersion: 2,
  revision: 1,
  assets: {
    [id]: {
      ...state.manifest.assets[id],
      published: {
        generation: 1,
        variants: { '480p': `processed/assets/${id}/1/480p.mp4` },
        sources: { '480p': `processed/assets/${id}/1/480p.mp4` },
        poster: `processed/assets/${id}/1/poster.jpg`,
        duration: 3,
        aspect: 1.77,
      },
    },
  },
};
const resolved = resolveMedia(
  buildManifest,
  { slug: 'post', media: { videos: [id], gallery: [], music: [], cover: id } },
  { mediaBase: 'https://media.example' },
);
assert.equal(resolved.videos.length, 1);
assert.equal(resolved.videos[0].id, id);
assert.equal(resolved.videos[0].poster, `https://media.example/processed/assets/${id}/1/poster.jpg`);
const legacyResolved = resolveMedia({ schemaVersion: 1, revision: 0, assets: {} }, 'legacy-post', {
  mediaBase: 'https://media.example',
});
assert.equal(legacyResolved.photos.length, 0);

console.log('Media assets: v2 build resolution passed');

// Import path used by the migration CLI: validated v2 assets can be merged
// without pretending they came from an upload job.
const importedId = newAssetId();
await runtime.call('import-v2', {
  assets: [
    {
      id: importedId,
      v2: true,
      filename: 'imported.jpg',
      folder: 'photos',
      generation: 1,
      status: 'ready',
      source: { key: `originals/assets/${importedId}/imported.jpg`, etag: 'imported', available: true },
      published: { generation: 1, variants: { '480p': `processed/assets/${importedId}/1/480p.jpg` } },
      lifecycle: { state: 'ready', health: { level: 'ok', reasons: [] } },
    },
  ],
});
const imported = await runtime.call('assets-list', {});
assert.ok(imported.assets.some((asset) => asset.id === importedId));
await assert.rejects(
  () => runtime.call('import-v2', { assets: [{ id: 'not-an-asset', v2: true }] }),
  /Invalid v2 asset/,
);

console.log('Media assets: migration import path passed');
