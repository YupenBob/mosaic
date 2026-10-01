import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSite } from '../scripts/site/generate.mjs';
import { loadContext, ROOT } from '../scripts/lib/context.mjs';
import { emptyManifest, assetId } from '../shared/media-manifest.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-site-'));
try {
  fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'content/posts/post'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mosaic'));
  fs.writeFileSync(
    path.join(root, 'mosaic.config.json'),
    JSON.stringify({
      title: 'Fixture',
      url: 'https://site.test',
      mediaBase: 'https://media.test',
      apiBase: '/api',
      pageSize: 1,
    }),
  );
  fs.writeFileSync(
    path.join(root, 'content/posts/post/index.md'),
    '---\ntitle: Post\ncategory: parent/child/grandchild\ntags: [test]\n---\n\n{{video:0}}\n\nBody\n\n{{photo:0}}\n',
  );
  const manifest = emptyManifest();
  manifest.revision = 7;
  const add = (folder, filename, published = null) => {
    const id = assetId('post', filename, folder);
    manifest.assets[id] = { id, slug: 'post', filename, folder, status: published ? 'ready' : 'pending', published };
  };
  add('videos', 'a.mp4');
  add('videos', 'b.mp4', {
    poster: 'processed/post/videos/v1/poster.jpg',
    hls: 'processed/post/videos/v1/master.m3u8',
    sources: { '240p': 'processed/post/videos/v1/240p.mp4' },
  });
  add('photos', 'a.jpg', {
    original: 'processed/post/photos/v1/original.png',
    placeholder: 'processed/post/photos/v1/placeholder.webp',
    variants: { '480p': 'processed/post/photos/v1/480p.webp' },
    aspect: 1.5,
  });
  add('music', 'a.flac', {
    sources: { '128k': 'processed/post/music/v1/128k.mp3' },
    waveform: Array(400).fill(0.5),
    duration: 1,
  });
  fs.writeFileSync(path.join(root, '.mosaic/media-manifest.json'), JSON.stringify(manifest));
  const context = loadContext({ MOSAIC_ROOT: root });
  const result = generateSite(context);
  assert.equal(result.mediaRevision, 7);
  assert.ok(!fs.existsSync(path.join(root, 'content/posts/post/videos')), 'build must not need local originals');
  assert.ok(!fs.existsSync(path.join(context.dist, '.media-checksums.json')));
  const listing = JSON.parse(fs.readFileSync(path.join(context.dist, 'data/posts-index.json')));
  assert.equal(listing.length, 1);
  assert.ok(!('bodyHTML' in listing[0]) && !('music' in listing[0]) && !('videos' in listing[0]));
  const posts = JSON.parse(fs.readFileSync(path.join(context.dist, 'data/posts.json')));
  assert.equal(posts[0].videos[0].pending, true, 'pending media preserve positional references');
  assert.ok(posts[0].videos[1].hls.startsWith('https://media.test/processed/'));
  const html = fs.readFileSync(path.join(context.dist, 'posts/post/index.html'), 'utf8');
  assert.match(html, /media-pending/);
  assert.ok(!html.includes('undefined'), 'no speculative media URLs');
  assert.ok(fs.existsSync(path.join(context.dist, 'categories/parent/child/grandchild/index.html')));
  fs.writeFileSync(path.join(context.dist, 'stale.html'), 'stale');
  generateSite(context);
  assert.ok(!fs.existsSync(path.join(context.dist, 'stale.html')), 'deleted pages must not survive rebuild');
  const same = JSON.parse(fs.readFileSync(path.join(context.dist, 'data/posts-index.json')));
  assert.deepEqual(listing, same, 'same content and manifest produce the same index');
  manifest.assets['post/videos/a.mp4'].published = manifest.assets['post/videos/b.mp4'].published;
  manifest.assets['post/videos/a.mp4'].status = 'processing';
  fs.writeFileSync(context.manifestPath, JSON.stringify(manifest));
  generateSite(context);
  const replaced = JSON.parse(fs.readFileSync(path.join(context.dist, 'data/posts.json')));
  assert.equal(replaced[0].videos[0].pending, undefined, 'a replacement continues using its published version');
  assert.throws(() => generateSite({ ...context, dist: root }), /Unsafe site output/);
  console.log(
    'Site smoke: manifest-only generation, pending slots, previous versions, thin index, deep categories, deterministic data and clean output passed',
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
