/**
 * Unit tests for the video pipeline decision logic (no ffmpeg / R2 deps).
 * Run: node tests/upload-logic-smoke.mjs  (wired into `npm run check`)
 */
import assert from 'node:assert/strict';
import { ALL_RES, tierListFor, uploadAfterN, budgetExceeded, manifestComplete } from '../scripts/media-utils.mjs';
import { contentTypeFor } from '../worker/scripts/r2-upload.mjs';

let passed = 0;
const results = [];
function record(name, fn) {
  try {
    fn();
    passed++;
    results.push(`PASS ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
  }
}

record('ALL_RES master order preserved (descending)', () => {
  assert.deepEqual(
    ALL_RES.map((r) => r.name),
    ['4K', '1080p', '720p', '480p', '360p', '240p'],
  );
});

record('tierListFor ascending + maxHeight filter', () => {
  assert.deepEqual(tierListFor(2160, 1080), ['240p', '360p', '480p', '720p', '1080p']);
  assert.deepEqual(tierListFor(2160, 2160), ['240p', '360p', '480p', '720p', '1080p', '4K']);
  assert.deepEqual(tierListFor(480, 1080), ['240p', '360p', '480p']);
  assert.deepEqual(tierListFor(200, 1080), []);
});

record('uploadAfterN batch boundaries (multiples + final flush)', () => {
  assert.equal(uploadAfterN(1, 5, 1), true); // per-tier default
  assert.equal(uploadAfterN(2, 5, 1), true);
  assert.equal(uploadAfterN(2, 5, 2), true); // multiple of batch size
  assert.equal(uploadAfterN(3, 5, 2), false); // neither multiple nor last
  assert.equal(uploadAfterN(5, 5, 2), true); // final partial batch flush
  assert.equal(uploadAfterN(0, 5, 1), false); // nothing done yet
});

record('budgetExceeded boundary (85% of timeout)', () => {
  const timeout = 90;
  const budgetMs = 90 * 60 * 1000 * 0.85;
  assert.equal(budgetExceeded(budgetMs - 1, timeout), false);
  assert.equal(budgetExceeded(budgetMs, timeout), true);
  assert.equal(budgetExceeded(budgetMs + 1000, timeout), true);
});

record('manifestComplete full / partial / empty / null', () => {
  const expected = ['240p', '360p', '480p', '720p', '1080p'];
  assert.equal(manifestComplete({ tiers: expected }, expected), true);
  assert.equal(manifestComplete({ tiers: [...expected, '4K'] }, expected), true); // extra tiers OK
  assert.equal(manifestComplete({ tiers: ['240p', '360p'] }, expected), false);
  assert.equal(manifestComplete({ tiers: [] }, expected), false);
  assert.equal(manifestComplete(null, expected), false);
  assert.equal(manifestComplete({}, expected), false);
});

record('contentTypeFor mapping + fallback', () => {
  assert.equal(contentTypeFor('x.m3u8'), 'application/vnd.apple.mpegurl');
  assert.equal(contentTypeFor('x.ts'), 'video/mp2t');
  assert.equal(contentTypeFor('x.mp4'), 'video/mp4');
  assert.equal(contentTypeFor('x.jpg'), 'image/jpeg');
  assert.equal(contentTypeFor('x.unknown'), 'application/octet-stream');
});

console.log(results.map((r) => `  ${r}`).join('\n'));
console.log(`\nUpload logic smoke: ${passed} groups passed`);
if (passed < 6) process.exit(1);
