import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';
import { listMedia } from '../worker/src/r2.js';
import { emptyManifest } from '../shared/media-manifest.mjs';
import { resolveMedia } from '../scripts/site/media.mjs';
const runtime = createRuntime(),
  manifest = emptyManifest();
for (const [filename, folder, order, published, available] of [
  ['z.jpg', 'photos', 2, { variants: { '480p': 'processed/post/z.webp' } }, true],
  ['a.jpg', 'photos', 10, { variants: { '480p': 'processed/post/a.webp' } }, true],
  ['cover.jpg', 'covers', 0, { variants: { '480p': 'processed/post/cover.webp' } }, false],
  [
    'clip.mp4',
    'videos',
    0,
    { poster: 'processed/post/poster.webp', sources: { '240p': 'processed/post/clip.mp4' } },
    true,
  ],
]) {
  const id = `post/${folder}/${filename}`;
  for (const value of Object.values(published))
    for (const key of typeof value === 'string' ? [value] : Object.values(value))
      await runtime.bucket.put(key, 'fixture');
  const sourceKey = `originals/post/${folder}/${filename}`;
  if (available) await runtime.bucket.put(sourceKey, 'fixture');
  manifest.assets[id] = {
    id,
    slug: 'post',
    filename,
    folder,
    order,
    status: 'ready',
    published,
    source: { key: sourceKey, available },
  };
}
await runtime.call('import', { manifest, config: runtime.config });
const result = await listMedia(
  { req: { param: () => 'post' }, env: runtime.env, json: (value) => value },
  'https://media.example',
);
assert.deepEqual(
  result.photos.map((p) => p.name),
  ['z.jpg', 'a.jpg'],
  'display order is numeric',
);
assert.equal(result.covers.length, 1, 'orphan cover survives without changing photo indexes');
assert.equal(result.covers[0].url, 'https://media.example/processed/post/cover.webp');
assert.equal(result.videos[0].previewUrl, 'https://media.example/processed/post/poster.webp');
assert.equal(result.photos[0].previewUrl, 'https://media.example/processed/post/z.webp');
assert.deepEqual(
  resolveMedia(manifest, 'post', { mediaBase: 'https://media.example' }).photos.map((p) => p.file),
  result.photos.map((p) => p.name),
  'editor and build have identical photo indexes',
);
const projection = await runtime.call('media-list', { slug: 'post' });
assert.ok(
  projection.every((item) => !('waveform' in item) && !('source' in item)),
  'list projection has no processing payload',
);
console.log('Media list: actual previews, orphan covers, numeric order and editor/build index parity passed');
