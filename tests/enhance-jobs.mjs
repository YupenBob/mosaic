/**
 * Video enhancement job options: interpolate / re-encode / both, and
 * processed vs original source modes.
 */
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';
import { newAssetId } from '../shared/media-v2.mjs';
import { interpolateMedia } from '../worker/src/services/jobs.js';

const runtime = createRuntime();
const config = structuredClone(runtime.config);
config.videoQuality.interpolation.enabled = true;
config.videoQuality.crf = 20;

const id = newAssetId();
await runtime.enqueueAsset('clip.mp4', Buffer.from('source-video'), { id, config });
const claimed = await runtime.call('claim', { runId: 'enhance-1' });
await runtime.bucket.put(`processed/assets/${id}/${claimed.job.generation}/480p.mp4`, 'encoded');
await runtime.call('publish', {
  id: claimed.job.id,
  token: claimed.job.token,
  runId: 'enhance-1',
  published: { sources: { '480p': `processed/assets/${id}/${claimed.job.generation}/480p.mp4` } },
  complete: true,
});

const interpolated = await runtime.call('interpolate', {
  assetIds: [id],
  operation: 'interpolate',
  sourceMode: 'processed',
  fps: 60,
  config,
  stateConfig: config,
  configHash: 'enhance',
});
assert.equal(interpolated.enqueued, 1);
let state = await runtime.call('state');
let asset = state.manifest.assets[id];
let job = state.jobs.find((candidate) => candidate.id === asset.jobId);
assert.equal(job.options.sourceMode, 'processed');
assert.equal(job.options.operation, 'interpolate');
assert.equal(job.options.interpolation.fps, 60);
assert.ok(job.processedSources['480p']);

const reencoded = await runtime.call('interpolate', {
  assetIds: [id],
  operation: 'reencode',
  sourceMode: 'original',
  reencode: { crf: 27, preset: 'fast', audioBitrate: '96k' },
  config: { ...config, videoQuality: { ...config.videoQuality, crf: 27, preset: 'fast', audioBitrate: '96k' } },
  stateConfig: config,
  configHash: 'enhance',
});
assert.equal(reencoded.enqueued, 1);
state = await runtime.call('state');
asset = state.manifest.assets[id];
job = state.jobs.find((candidate) => candidate.id === asset.jobId);
assert.equal(job.options.sourceMode, 'original');
assert.equal(job.options.operation, 'reencode');
assert.equal(job.options.interpolation.enabled, false);
assert.equal(job.options.reencode.crf, 27);

const both = await runtime.call('interpolate', {
  assetIds: [id],
  operation: 'both',
  sourceMode: 'processed',
  fps: 60,
  config,
  stateConfig: config,
  configHash: 'enhance',
});
assert.equal(both.enqueued, 1);
state = await runtime.call('state');
job = state.jobs.find((candidate) => candidate.id === state.manifest.assets[id].jobId);
assert.equal(job.options.operation, 'both');
assert.equal(job.options.interpolation.enabled, true);

console.log('Enhance jobs: re-encode, original source and both modes passed');

await assert.rejects(
  () => interpolateMedia({ env: { JOBS: {} } }, { slug: 'post', assetIds: ['not-an-asset'] }),
  /assetIds must be valid/,
);
await assert.rejects(
  () => interpolateMedia({ env: { JOBS: {} } }, { slug: 'post', operation: 'magic' }),
  /operation must be/,
);
await assert.rejects(
  () => interpolateMedia({ env: { JOBS: {} } }, { slug: 'post', reencode: { crf: 80 } }),
  /reencode.crf/,
);

console.log('Enhance API: invalid asset ids/operations/reencode rejected');
