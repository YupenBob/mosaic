/**
 * Card media browser regression (v2.1).
 *
 * Verifies the two layout-loading features that unit tests cannot:
 *  - cards render a few-KB LQIP first (`src`) with the HD URL deferred in
 *    `data-src`, then upgrade in place without a layout jump;
 *  - the masonry packing is applied (CSS multi-column + JS packing) with a
 *    per-card height and equal column widths in Chromium *and* WebKit (Safari
 *    mis-sizes `aspect-ratio` cards inside CSS multi-column, so this guards the
 *    JS fallback from regressing).
 *
 * Run: node tests/cards-media.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium, webkit } from 'playwright';
import { ROOT, loadContext } from '../scripts/lib/context.mjs';
import { generateSite } from '../scripts/site/generate.mjs';
import { emptyManifest } from '../shared/media-manifest.mjs';
import { serveDirectory } from './helpers/static-server.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-cards-'));
const errors = [];
try {
  fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mosaic'));
  fs.writeFileSync(
    path.join(root, 'mosaic.config.json'),
    JSON.stringify({ title: 'Cards fixture', url: 'http://127.0.0.1', mediaBase: '', pageSize: 50 }),
  );
  const posts = [
    ['landscape', 1.5],
    ['square', 1],
    ['portrait', 0.75],
    ['wide', 1.2],
  ];
  const manifest = emptyManifest();
  for (const [slug, aspect] of posts) {
    fs.mkdirSync(path.join(root, 'content/posts', slug), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'content/posts', slug, 'index.md'),
      `---\ntitle: ${slug}\ncategory: fixture\ntags: [test]\ncover: photo:0\n---\n\nFixture ${slug}\n`,
    );
    const id = `${slug}/photos/cover.jpg`;
    manifest.assets[id] = {
      id,
      slug,
      folder: 'photos',
      filename: 'cover.jpg',
      status: 'ready',
      published: {
        original: 'fixture/cover.jpg',
        placeholder: 'fixture/preview.webp',
        variants: { '480p': 'fixture/cover.jpg', '720p': 'fixture/cover.jpg' },
        aspect,
      },
    };
  }
  fs.writeFileSync(path.join(root, '.mosaic/media-manifest.json'), JSON.stringify(manifest));
  generateSite(loadContext({ MOSAIC_ROOT: root }));

  // Media fixture files (dist/fixture/...)
  const fixtureDir = path.join(root, 'dist/fixture');
  fs.mkdirSync(fixtureDir, { recursive: true });
  await sharp({ create: { width: 900, height: 600, channels: 3, background: '#4361ee' } })
    .jpeg()
    .toFile(path.join(fixtureDir, 'cover.jpg'));
  await sharp({ create: { width: 900, height: 600, channels: 3, background: '#4361ee' } })
    .resize({ width: 64 })
    .webp({ quality: 30 })
    .toFile(path.join(fixtureDir, 'preview.webp'));

  const server = await serveDirectory(path.join(root, 'dist'));
  const ssrHtml = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
  assert.match(ssrHtml, /post-card-img is-lqip/, 'SSR must ship the LQIP first');
  assert.match(ssrHtml, /data-src="\/fixture\/cover\.jpg"/, 'SSR defers the HD URL');
  assert.match(ssrHtml, /<noscript>/, 'no-JS fallback exists');
  try {
    for (const engine of [chromium, webkit]) {
      const browser = await engine.launch({ headless: true });
      try {
        for (const viewport of [
          { width: 1440, height: 1000 },
          { width: 390, height: 844 },
        ]) {
          const page = await browser.newPage({ viewport });
          page.setDefaultTimeout(60000);
          page.setDefaultNavigationTimeout(60000);
          page.on('pageerror', (error) => errors.push(`${engine.name()}: ${error.message}`));
          await page.goto(server.url, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(400);
          // Priority (above-the-fold) cards upgrade immediately; the rest wait
          // for visibility, so scroll to the end before asserting all upgraded.
          await page.waitForFunction(
            () => document.querySelectorAll('.post-card-img[data-upgraded="true"]').length >= 2,
          );
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForFunction(() => {
            const imgs = [...document.querySelectorAll('.post-card-img')];
            return imgs.length > 0 && imgs.every((img) => img.dataset.upgraded === 'true');
          });
          const result = await page.evaluate(() => {
            const grid = document.querySelector('.card-grid');
            const cards = [...document.querySelectorAll('.post-card')].map((card) => {
              const rect = card.getBoundingClientRect();
              const img = card.querySelector('.post-card-img');
              return {
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                src: img?.getAttribute('src') || '',
                lqip: img?.classList.contains('is-lqip'),
                top: Math.round(rect.top),
                left: Math.round(rect.left),
              };
            });
            const gridRect = grid.getBoundingClientRect();
            return {
              isMasonry: grid.classList.contains('is-masonry'),
              display: getComputedStyle(grid).display,
              gridHeight: Math.round(gridRect.height),
              gridWidth: Math.round(gridRect.width),
              overflow: document.documentElement.scrollWidth - window.innerWidth,
              cards,
            };
          });
          assert.equal(result.overflow, 0, `${engine.name()} ${viewport.width}: no horizontal overflow`);
          assert.equal(result.isMasonry, true, `${engine.name()} ${viewport.width}: masonry packing applied`);
          assert.equal(result.display, 'block');
          assert.ok(result.cards.length === 4);
          const width = result.cards[0].width;
          assert.ok(width > 100, `${engine.name()} ${viewport.width}: cards have a real width (WebKit regression)`);
          assert.ok(
            result.cards.every((card) => Math.abs(card.width - width) <= 1),
            `${engine.name()} ${viewport.width}: equal column widths`,
          );
          assert.deepEqual(
            [...new Set(result.cards.map((card) => card.height))].length > 1,
            true,
            `${engine.name()} ${viewport.width}: cards keep their own heights`,
          );
          assert.ok(result.gridHeight > Math.max(...result.cards.map((card) => card.height)));
          assert.ok(
            result.cards.every((card) => !card.lqip && /cover\.jpg/.test(card.src)),
            `${engine.name()} ${viewport.width}: every card upgraded to the HD image`,
          );
          // Column count mirrors the CSS custom property (1 mobile / 3 desktop).
          const expectedColumns = viewport.width >= 1440 ? 3 : 1;
          const columns = new Set(result.cards.map((card) => card.left)).size;
          assert.equal(columns, expectedColumns, `${engine.name()} ${viewport.width}: column count`);
          await page.close();
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
  assert.deepEqual(errors, [], 'no JavaScript errors');
  console.log(
    'Cards media: SSR LQIP-first markup, in-place HD upgrade, masonry heights/columns, WebKit card sizing and no overflow passed (Chromium + WebKit, 1440/390)',
  );
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* best-effort on Windows */
  }
}
