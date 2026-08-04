/**
 * Unit tests for the content-block model (scripts/blocks.mjs).
 *
 * Run: node tests/blocks-smoke.mjs
 */
import assert from 'node:assert/strict';
import { buildBlocks } from '../scripts/blocks.mjs';

let passed = 0;
const results = [];
async function record(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`PASS ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
  }
}

const photos = [{ base: 'a' }, { base: 'b' }];
const videos = [{ base: 'v1' }, { base: 'v2' }];
const music = [{ file: 'm1.mp3', title: 'M1' }];

await record('default order: text → gallery → videos → music', () => {
  const { blocks } = buildBlocks({ body: 'Hello', photos, videos, music, layout: 'default' });
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['text', 'gallery', 'videos', 'music'],
  );
  assert.match(blocks[0].html, /Hello/);
});

await record('gallery-first order', () => {
  const { blocks } = buildBlocks({ body: 'Hello', photos, videos, music, layout: 'gallery-first' });
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['gallery', 'text', 'videos', 'music'],
  );
});

await record('video-first order', () => {
  const { blocks } = buildBlocks({ body: 'Hello', photos, videos, music, layout: 'video-first' });
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['videos', 'text', 'gallery', 'music'],
  );
});

await record('empty media omits blocks', () => {
  const { blocks } = buildBlocks({ body: 'Hi', photos: [], videos: [], music: [] });
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['text'],
  );
});

await record('videos block carries playlist mode', () => {
  const { blocks } = buildBlocks({ body: 'x', photos: [], videos, music: [], videoMode: 'playlist' });
  assert.equal(blocks.find((b) => b.type === 'videos').mode, 'playlist');
});

console.log(results.map((r) => `  ${r}`).join('\n'));
console.log(`\nblocks-smoke: ${passed} groups passed`);
if (passed < 5) process.exit(1);
