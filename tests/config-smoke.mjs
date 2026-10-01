import assert from 'node:assert/strict';
import { normalizeConfig, validateConfig, processingConfig, DEFAULTS } from '../shared/config.mjs';
import { fingerprint, assetId } from '../shared/media-manifest.mjs';
const config = normalizeConfig(
  { build: { timeoutMinutes: 120 }, enableVideoCompression: false },
  { R2_BUCKET: 'custom-bucket', SITE_BRANCH: 'production' },
);
assert.equal(config.media.timeoutMinutes, 120);
assert.equal(config.deployment.branch, 'production');
assert.equal(config.mediaSource.bucket, 'custom-bucket');
assert.equal(config.plugins['compress-videos'].enabled, false);
assert.equal(DEFAULTS.mediaSource.bucket, 'mosaic-media', 'normalization must not mutate defaults');
assert.equal(DEFAULTS.media.timeoutMinutes, 90);
assert.equal(
  normalizeConfig({ enableVideoCompression: false, plugins: { 'compress-videos': { enabled: true } } }).plugins[
    'compress-videos'
  ].enabled,
  true,
);
assert.deepEqual(validateConfig(config), []);
assert.ok(validateConfig(normalizeConfig({ videoQuality: { crf: -1 } })).length);
assert.throws(() => normalizeConfig(JSON.parse('{"__proto__":{"polluted":true}}')));
assert.throws(() => assetId('../post', 'clip.mp4'));
const first = normalizeConfig({ title: 'A' }),
  second = normalizeConfig({ title: 'B' });
assert.equal(
  await fingerprint(processingConfig(first, 'videos')),
  await fingerprint(processingConfig(second, 'videos')),
  'title changes must not invalidate video encoding',
);
assert.notEqual(
  await fingerprint(processingConfig(first, 'videos')),
  await fingerprint(processingConfig(normalizeConfig({ videoQuality: { crf: 30 } }), 'videos')),
);
console.log('Config smoke: defaults, overrides, legacy fields, isolation and processor fingerprints passed');
