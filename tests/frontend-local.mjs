import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { ROOT, loadContext } from '../scripts/lib/context.mjs';
import { generateSite } from '../scripts/site/generate.mjs';
import { emptyManifest } from '../shared/media-manifest.mjs';
import { serveDirectory } from './helpers/static-server.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-browser-'));
const server = await serveDirectory(path.join(root, 'dist'));
const errors = [],
  requests = [];
try {
  fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mosaic'));
  fs.writeFileSync(
    path.join(root, 'mosaic.config.json'),
    JSON.stringify({
      title: 'Fixture',
      url: server.url,
      mediaBase: server.url,
      apiBase: '/api',
      components: { stats: { enabled: false }, likes: { enabled: false } },
      player: { hls: { maxBufferLength: 12 } },
    }),
  );
  for (const slug of ['blocks', 'playlist']) {
    fs.mkdirSync(path.join(root, 'content/posts', slug), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'content/posts', slug, 'index.md'),
      `---\ntitle: Fixture ${slug}\ncategory: parent/child\ntags: [test]\nvideo_mode: playlist\n---\n\n${slug === 'blocks' ? '{{photo:0}}\n\n{{video:0}}\n\n{{music:0}}' : 'Playlist body'}`,
    );
  }
  const manifest = emptyManifest();
  const add = (slug, folder, filename, published) => {
    const id = `${slug}/${folder}/${filename}`;
    manifest.assets[id] = { id, slug, folder, filename, status: published ? 'ready' : 'pending', published };
  };
  add('blocks', 'photos', 'photo.jpg', {
    original: 'fixture/photo.jpg',
    placeholder: 'fixture/photo.jpg',
    variants: { '480p': 'fixture/photo.jpg', '720p': 'fixture/photo.jpg', '1080p': 'fixture/photo.jpg' },
    aspect: 1.5,
  });
  add('blocks', 'videos', 'pending.mp4');
  add('blocks', 'music', 'track.mp3', {
    title: 'Fixture song',
    sources: { '128k': 'fixture/track.mp3' },
    duration: 1,
    waveform: [0.2, 0.6],
  });
  for (const filename of ['a.mp4', 'b.mp4'])
    add('playlist', 'videos', filename, {
      poster: 'fixture/photo.jpg',
      hls: 'fixture/master.m3u8',
      sources: { '240p': 'fixture/clip.mp4' },
    });
  fs.writeFileSync(path.join(root, '.mosaic/media-manifest.json'), JSON.stringify(manifest));
  generateSite(loadContext({ MOSAIC_ROOT: root }));
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/media.json')));
  fs.mkdirSync(path.join(root, 'dist/fixture'));
  for (const [key, name] of [
    ['video', 'clip.mp4'],
    ['audio', 'track.mp3'],
    ['photo', 'photo.jpg'],
  ])
    fs.writeFileSync(path.join(root, 'dist/fixture', name), Buffer.from(fixture[key], 'base64'));
  for (const engine of [chromium, webkit]) {
    console.log(`Browser regression: ${engine.name()}`);
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        requests.push(url.pathname);
        if (url.origin !== server.url) return route.abort();
        if (url.pathname.endsWith('/vendor/hls.min.js')) return route.abort();
        if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { views: 0, likes: 0 } });
        return route.continue();
      });
      await page.addInitScript(() => {
        window.Hls = class {
          static isSupported() {
            return true;
          }
          constructor(options) {
            this.options = options;
            this.handlers = {};
            this.levels = [{ height: 240, bitrate: 250000 }];
          }
          on(name, handler) {
            this.handlers[name] = handler;
          }
          loadSource() {}
          attachMedia() {
            setTimeout(() => this.handlers.hlsManifestParsed?.(), 50);
          }
          destroy() {
            this.destroyed = true;
          }
          startLoad() {}
          recoverMediaError() {}
        };
      });
      const indexResponse = page.waitForResponse((response) => response.url().endsWith('/data/posts-index.json'));
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await indexResponse;
      assert.ok(requests.includes('/data/posts-index.json'));
      assert.ok(!requests.includes('/data/posts.json'), 'list pages must not fetch full articles');
      await page.goto(`${server.url}/posts/blocks/`, { waitUntil: 'domcontentloaded' });
      await page.locator('.gallery-item, .gallery-single img').first().waitFor();
      assert.equal(await page.locator('.media-pending').count(), 1);
      assert.equal(await page.locator('.music-track').count(), 1);
      const tracks = await page.evaluate(() => window.__MUSIC_TRACKS);
      assert.equal(tracks.length, 1, 'music module must preserve template track data');
      await page.locator('#gallery-overlay').waitFor({ state: 'attached' });
      await page.locator('.gallery-single img').first().click();
      await page.locator('#gallery-current-img').waitFor({ state: 'visible' });
      await page.locator('.gq-pill[data-res="720p"]').click();
      assert.ok((await page.locator('#gallery-current-img').getAttribute('src')).includes('fixture/photo.jpg'));
      await page.keyboard.press('Escape');
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
        await page.waitForTimeout(400);
        await page.addScriptTag({ path: path.join(ROOT, 'node_modules/axe-core/axe.min.js') });
        const serious = await page.evaluate(async () =>
          (await window.axe.run(document)).violations
            .filter((v) => ['serious', 'critical'].includes(v.impact))
            .map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
        );
        assert.deepEqual(serious, [], `${engine.name()} / ${theme} accessibility`);
      }
      await page.goto(`${server.url}/posts/playlist/`, { waitUntil: 'domcontentloaded' });
      console.log(`  ${engine.name()}: checking published playlist`);
      await page.waitForFunction(() => !!document.querySelector('.video-element')?._hls);
      assert.equal(
        await page.evaluate(() => document.querySelector('.video-element')._hls.options.maxBufferLength),
        12,
      );
      const sources = await page.locator('.vc-quality-menu').first().innerText();
      assert.ok(
        sources.includes('240p') && !sources.includes('1080p'),
        'quality controls advertise published tiers only',
      );
      await page.evaluate(() => {
        const element = document.querySelector('.video-element'),
          hls = element._hls;
        for (let i = 0; i < 3; i++) hls.handlers.hlsError(null, { fatal: true, type: 'networkError' });
      });
      await page.waitForFunction(() => document.querySelector('.video-element').src.endsWith('clip.mp4'));
      await page.locator('.pl-item').nth(1).click();
      assert.equal(await page.locator('.pl-item.active').getAttribute('data-index'), '1');
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'mobile playlist must not overflow',
      );
      const cleanup = await page.evaluate(async () => {
        const { initVideoPlayers } = await import('/assets/js/video.js');
        const dispose = initVideoPlayers();
        const hls = [...document.querySelectorAll('.video-element')].map((element) => element._hls).filter(Boolean);
        dispose();
        return hls.every((value) => value.destroyed);
      });
      assert.equal(cleanup, true);
      await page.goto(`${server.url}/categories/parent/`, { waitUntil: 'domcontentloaded' });
      console.log(`  ${engine.name()}: checking categories`);
      assert.equal(await page.locator('.post-card').count(), 2);
    } finally {
      await browser.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'Local frontend: thin index, content blocks, gallery, music, pending media, published HLS tiers, MP4 recovery, playlists, lifecycle, mobile Chromium/WebKit and dual-theme accessibility passed',
  );
} finally {
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
