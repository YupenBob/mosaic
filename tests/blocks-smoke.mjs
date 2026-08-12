/**
 * Unit tests for the content-block model (scripts/blocks.mjs).
 *
 * Run: node tests/blocks-smoke.mjs
 */
import assert from 'node:assert/strict';
import { buildBlocks, deriveType } from '../scripts/blocks.mjs';

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
  const { blocks } = buildBlocks({ body: 'Hello', photos, videos, music });
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['text', 'gallery', 'videos', 'music'],
  );
  assert.match(blocks[0].html, /Hello/);
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

await record('blocksOrder explicit ordering (no placeholders)', () => {
  const { blocks } = buildBlocks({
    body: 'Hello',
    photos,
    videos,
    music,
    blocksOrder: ['music', 'text', 'gallery'],
  });
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['music', 'text', 'gallery'],
  );
});

// ── Phase C: placeholder composition ──
await record('placeholders interleave text and media', () => {
  const body = 'Intro\n\n{{gallery}}\n\nMid\n\n{{video:0}}\n\nOut';
  const { blocks } = buildBlocks({ body, photos, videos, music });
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['text', 'gallery', 'text', 'video', 'text', 'music'],
  );
  assert.match(blocks[0].html, /Intro/);
  assert.match(blocks[2].html, /Mid/);
  assert.match(blocks[4].html, /Out/);
  assert.equal(blocks[3].video.base, 'v1');
});

await record('video:N suppresses the auto-appended videos block', () => {
  const body = 'Intro\n\n{{video:0}}\n\nOut';
  const { blocks } = buildBlocks({ body, photos, videos, music });
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ['text', 'video', 'text', 'gallery', 'music']);
  assert.equal(types.filter((t) => t === 'videos').length, 0);
});

await record('photo:N suppresses the auto-appended gallery block', () => {
  const body = 'Intro\n\n{{photo:0}}\n\nOut';
  const { blocks } = buildBlocks({ body, photos, videos, music });
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ['text', 'photo', 'text', 'videos', 'music']);
  assert.equal(types.filter((t) => t === 'gallery').length, 0);
});

await record('unreferenced media appended once, no duplicates', () => {
  const body = 'Hello\n\n{{gallery}}\n\nWorld';
  const { blocks } = buildBlocks({ body, photos, videos, music });
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ['text', 'gallery', 'text', 'videos', 'music']);
  assert.equal(types.filter((t) => t === 'gallery').length, 1);
  assert.equal(types.filter((t) => t === 'videos').length, 1);
});

await record('out-of-range video:N stays literal', () => {
  const body = 'Hello\n\n{{video:9}}\n\nWorld';
  const { blocks } = buildBlocks({ body, photos, videos, music });
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['text', 'gallery', 'videos', 'music'],
  );
  assert.match(blocks[0].html, /\{\{video:9\}\}/);
});

await record('placeholder not alone on a line stays literal', () => {
  const body = 'See {{gallery}} here';
  const { blocks } = buildBlocks({ body, photos, videos, music });
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['text', 'gallery', 'videos', 'music'],
  );
  assert.match(blocks[0].html, /\{\{gallery\}\}/);
});

await record('placeholder inside a code fence stays literal', () => {
  const body = '```\n{{gallery}}\n```';
  const { blocks } = buildBlocks({ body, photos, videos, music });
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['text', 'gallery', 'videos', 'music'],
  );
  assert.match(blocks[0].html, /\{\{gallery\}\}/);
});

await record('{{gallery}} with no photos renders nothing and appends others', () => {
  const body = 'Hi\n\n{{gallery}}\n\nBye';
  const { blocks } = buildBlocks({ body, photos: [], videos, music });
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['text', 'text', 'videos', 'music'],
  );
  assert.match(blocks[1].html, /Bye/);
});

await record('deriveType: text/gallery/video/music/mixed', () => {
  assert.equal(deriveType([{ type: 'text' }]), 'text');
  assert.equal(deriveType([{ type: 'text' }, { type: 'gallery' }]), 'gallery');
  assert.equal(deriveType([{ type: 'text' }, { type: 'videos' }]), 'video');
  assert.equal(deriveType([{ type: 'music' }]), 'music');
  assert.equal(deriveType([{ type: 'gallery' }, { type: 'videos' }]), 'mixed');
  assert.equal(deriveType([{ type: 'photo' }]), 'gallery');
});

console.log(results.map((r) => `  ${r}`).join('\n'));
console.log(`\nblocks-smoke: ${passed} groups passed`);
if (passed !== results.length) process.exit(1);
