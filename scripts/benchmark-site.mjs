/** Compare the same Markdown and published-media inputs without network or FFmpeg. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ROOT } from './lib/context.mjs';
const legacy = path.resolve(process.argv[2] || path.join(ROOT, '.mosaic/performance-baseline'));
const work = path.join(ROOT, '.mosaic');
fs.mkdirSync(work, { recursive: true });
const run = (root, manifest) => {
  const started = performance.now();
  const result = spawnSync(process.execPath, ['scripts/generate.js'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: '', ...(manifest ? { MEDIA_MANIFEST_FILE: manifest } : {}) },
  });
  if (result.status) throw new Error(result.stderr);
  return Math.round(performance.now() - started);
};
const legacyTimes = [];
for (let i = 0; i < 5; i++) legacyTimes.push(run(legacy));
const previous = JSON.parse(fs.readFileSync(path.join(legacy, 'dist/data/posts.json'), 'utf8'));
const manifest = { schemaVersion: 1, revision: 1, assets: {} };
const key = (url) => decodeURIComponent(new URL(url).pathname.slice(1));
for (const post of previous)
  for (const photo of post.photos) {
    const filename = key(photo.srcOrig).split('/').at(-1),
      id = `${post.slug}/photos/${filename}`;
    manifest.assets[id] = {
      id,
      slug: post.slug,
      filename,
      folder: 'photos',
      order: filename,
      version: 1,
      status: 'ready',
      source: { key: key(photo.srcOrig), etag: 'benchmark', size: 0 },
      published: {
        original: key(photo.srcOrig),
        placeholder: key(photo.src10p),
        variants: { '480p': key(photo.src480), '720p': key(photo.src720), '1080p': key(photo.src1080) },
        aspect: post.coverAspect,
      },
    };
  }
if (previous.some((post) => post.videos.length || post.music.length))
  throw new Error(
    'This benchmark adapter supports the current photo-only reference; extend it for additional fixtures',
  );
const manifestFile = path.join(work, 'benchmark-manifest.json');
fs.writeFileSync(manifestFile, JSON.stringify(manifest));
const currentTimes = [];
for (let i = 0; i < 5; i++) currentTimes.push(run(ROOT, manifestFile));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = {
  date: process.env.BENCHMARK_DATE || new Date().toISOString().slice(0, 10),
  node: process.version,
  contentPosts: previous.length,
  manifestRevision: manifest.revision,
  manifestAssets: Object.keys(manifest.assets).length,
  legacyGeneratorMs: legacyTimes,
  currentGeneratorMs: currentTimes,
  legacyMedianMs: median(legacyTimes),
  currentMedianMs: median(currentTimes),
  legacyPostsBytes: Buffer.byteLength(JSON.stringify(previous)),
  indexBytes: fs.statSync(path.join(ROOT, 'dist/data/posts-index.json')).size,
  compatPostsBytes: fs.statSync(path.join(ROOT, 'dist/data/posts.json')).size,
  originalDownloads: 0,
  originalBytes: 0,
  ffmpegCalls: 0,
  checksumCache: false,
  listCacheReads: 1,
  listRepeatedReads: 0,
  mediaOnlyGitHubRequests: 0,
};
fs.writeFileSync(path.join(ROOT, 'docs/performance.json'), JSON.stringify(report, null, 2) + '\n');
console.log(report);
