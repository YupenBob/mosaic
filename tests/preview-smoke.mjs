/**
 * Preview/LQIP + shared card renderer smoke test (no browser, no ffmpeg).
 *
 * Covers the parts of the v2.1 image pipeline that are pure/data-level:
 *  - tiny WebP previews stay in the "few KB" range;
 *  - `resolveMedia()` exposes poster/cover previews without changing the
 *    published schema or requiring a config fingerprint change;
 *  - the shared card renderer ships the LQIP first, keeps the HD URL in
 *    `data-src`, reserves per-card aspect and includes a no-JS fallback;
 *  - the masonry/radius feature degrades to a plain HD image when no preview
 *    exists (legacy assets).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { writeWebpPreview } from '../scripts/media/preview.mjs';
import { resolveMedia } from '../scripts/site/media.mjs';
import { buildIndexes } from '../scripts/site/indexes.mjs';
import { renderCard } from '../src/assets/js/cards/render.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-preview-'));
try {
  // ── 1. preview generation stays tiny and keeps the aspect ratio ──────────
  const source = path.join(root, 'cover.jpg');
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#4361ee' } })
    .jpeg()
    .toFile(source);
  const preview = path.join(root, 'preview.webp');
  await writeWebpPreview({ input: source, output: preview, width: 150, quality: 30 });
  const previewMeta = await sharp(preview).metadata();
  assert.equal(previewMeta.format, 'webp');
  assert.ok(previewMeta.width <= 150, 'preview respects the configured width');
  assert.ok(
    fs.statSync(preview).size < 12000,
    `preview stays in the few-KB range (${fs.statSync(preview).size} bytes)`,
  );

  // ── 2. resolveMedia maps additive preview fields ─────────────────────────
  const manifest = {
    schemaVersion: 1,
    revision: 3,
    assets: {
      'p/photos/a.jpg': {
        id: 'p/photos/a.jpg',
        slug: 'p',
        filename: 'a.jpg',
        folder: 'photos',
        status: 'ready',
        published: {
          placeholder: 'processed/p/photos/1/placeholder.webp',
          variants: { '480p': 'processed/p/photos/1/480p.webp' },
          aspect: 1.5,
        },
      },
      'p/videos/v.mp4': {
        id: 'p/videos/v.mp4',
        slug: 'p',
        filename: 'v.mp4',
        folder: 'videos',
        status: 'ready',
        published: {
          poster: 'processed/p/videos/1/poster.jpg',
          posterPreview: 'processed/p/videos/1/poster-preview.webp',
          hls: 'processed/p/videos/1/master.m3u8',
          sources: { '720p': 'processed/p/videos/1/720p.mp4' },
          aspect: 16 / 9,
        },
      },
      'p/music/m.mp3': {
        id: 'p/music/m.mp3',
        slug: 'p',
        filename: 'm.mp3',
        folder: 'music',
        status: 'ready',
        published: {
          cover: 'processed/p/music/1/cover.jpg',
          coverPreview: 'processed/p/music/1/cover-preview.webp',
          sources: { '128k': 'processed/p/music/1/128k.mp3' },
          duration: 10,
        },
      },
    },
  };
  const site = { mediaBase: 'https://media.test', author: { name: 'A' } };
  const media = resolveMedia(manifest, 'p', site);
  assert.ok(media.photos[0].src10p.includes('placeholder.webp'), 'photo placeholder is exposed as LQIP');
  assert.ok(media.videos[0].posterLqip.includes('poster-preview.webp'), 'video preview is exposed');
  assert.ok(media.music[0].coverLqip.includes('cover-preview.webp'), 'music cover preview is exposed');

  // ── 3. listing carries coverLqip; legacy assets fall back to no LQIP ─────
  const posts = [
    {
      slug: 'with-preview',
      title: 'With preview',
      date: '2026-01-01T00:00:00.000Z',
      category: 'cat',
      tags: ['tag'],
      description: 'desc',
      cover: 'https://media.test/processed/p/videos/1/poster.jpg',
      coverLqip: 'https://media.test/processed/p/videos/1/poster-preview.webp',
      coverAspect: 1.5,
      coverSrcset: null,
      type: 'video',
      stats: { views: 1, likes: 2, dwell_time: 3 },
    },
    {
      slug: 'legacy',
      title: 'Legacy',
      date: '2026-01-02T00:00:00.000Z',
      category: 'cat',
      tags: [],
      description: '',
      cover: 'https://media.test/processed/p/videos/2/poster.jpg',
      coverAspect: 0.5, // extreme portrait is clamped for the masonry layout
      coverSrcset: null,
      type: 'video',
      stats: {},
      // no coverLqip (legacy asset processed before v2.1)
    },
  ];
  const { listing } = buildIndexes(posts);
  assert.equal(listing[0].coverLqip, posts[0].coverLqip);
  assert.equal(listing[1].coverLqip, undefined);

  const card = renderCard(listing[0], { base: '', priority: true });
  assert.match(card, /class="post-card-media" style="--cover-aspect:1\.5000"/, 'per-card aspect');
  assert.match(
    card,
    /class="post-card-img is-lqip" src="https:\/\/media.test\/processed\/p\/videos\/1\/poster-preview\.webp"/,
  );
  assert.match(card, /data-src="https:\/\/media.test\/processed\/p\/videos\/1\/poster\.jpg"/);
  assert.match(card, /data-priority="true"/);
  assert.match(card, /loading="eager" fetchpriority="high"/);
  assert.match(
    card,
    /<noscript><img class="post-card-img" src="https:\/\/media.test\/processed\/p\/videos\/1\/poster\.jpg"/,
  );

  const legacyCard = renderCard(listing[1], { base: '' });
  assert.doesNotMatch(legacyCard, /is-lqip/, 'legacy cards load the HD image directly');
  assert.match(legacyCard, /--cover-aspect:0\.6200/, 'extreme covers are clamped for readability');

  const textCard = renderCard(
    { slug: 'text', title: 'Text', category: 'cat', tags: [], description: '', cover: '', stats: {} },
    { base: '../' },
  );
  assert.match(textCard, /post-card--text/, 'text cards keep the compact variant');
  assert.match(textCard, /href="\.\.\/posts\/text\/"/, 'relative base is honoured');

  console.log(
    'Preview smoke: tiny WebP generation, resolver mappings, listing coverLqip, LQIP-first card markup, no-JS fallback, aspect clamping and legacy fallback passed',
  );
} finally {
  // Windows/Sharp may still hold a handle briefly; cleanup is best-effort.
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* temp dir will be reclaimed by the OS */
  }
}
