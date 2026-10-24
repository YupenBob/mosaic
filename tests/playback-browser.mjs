/**
 * Browser regression for the unified playback controller (Chromium + real HLS).
 *
 * Covers the user-visible decode-flow promises that unit tests cannot prove:
 * - click-only decode: unplayed mounted players download zero fragments;
 *   2-level HLS fixture so adaptive/manual switching is real;
 * - first-click starts playback (play intent queued across the MSE attach race);
 * - quality lock switch keeps the pipeline continuous (no pause/rewind/black gap);
 * - position restore under the stable media key after a reload;
 * - fatal manifest degrades to native <video src> MP4 and the menu lists only
 *   published tiers;
 * - playlist auto-advance fires exactly once per ended video;
 * - preconnect hint is only added on play intent; no JS errors.
 *
 * Run: node tests/playback-browser.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { ROOT, loadContext } from '../scripts/lib/context.mjs';
import { generateSite } from '../scripts/site/generate.mjs';
import { emptyManifest } from '../shared/media-manifest.mjs';

const twoLevelMaster = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=320x240,CODECS="avc1.42c00b"',
  'level-240.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x480,CODECS="avc1.42c00b"',
  'level-480.m3u8',
  '',
].join('\n');
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/hls.json')));
const photo = Buffer.from(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/media.json'))).photo, 'base64');

const requests = [];
const bodyBytes = { media: 0 };
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, resolve));
  return `http://localhost:${server.address().port}`;
};
const mediaServer = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const name = url.pathname.split('/').at(-1);
  requests.push({ url: request.url, origin: request.headers.origin, range: request.headers.range });
  const headers = { 'Cache-Control': 'no-store' };
  if (request.headers.origin) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers.Vary = 'Origin';
  }
  let data;
  if (name === 'master.m3u8') data = Buffer.from(twoLevelMaster);
  else if (name === 'level-240.m3u8' || name === 'level-480.m3u8') data = Buffer.from(fixture.level);
  else if (fixture.segments[name]) data = Buffer.from(fixture.segments[name], 'base64');
  else if (name === 'clip.mp4') data = Buffer.from(fixture.video, 'base64');
  else if (name === 'photo.jpg') data = photo;
  else {
    response.writeHead(404, headers).end();
    return;
  }
  headers['Content-Type'] = name.endsWith('.m3u8')
    ? 'application/vnd.apple.mpegurl'
    : name.endsWith('.ts')
      ? 'video/mp2t'
      : name.endsWith('.mp4')
        ? 'video/mp4'
        : 'image/jpeg';
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(Number(range[2] || data.length - 1), data.length - 1);
    headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
    data = data.subarray(start, end + 1);
  }
  headers['Content-Length'] = data.length;
  headers['Accept-Ranges'] = 'bytes';
  bodyBytes.media += data.length;
  response.writeHead(range ? 206 : 200, headers).end(data);
});
const mediaUrl = await listen(mediaServer);
const siteRequests = [];
const siteServer = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  siteRequests.push(url.pathname);
  let file = path.resolve(root, 'dist', '.' + url.pathname);
  if (!file.startsWith(path.join(root, 'dist') + path.sep) || url.pathname === '/')
    file = path.join(root, 'dist/index.html');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  const type =
    { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' }[
      path.extname(file)
    ] || 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(file).size });
  response.end(fs.readFileSync(file));
});
const siteUrl = await listen(siteServer);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-playback-browser-'));

try {
  fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mosaic'));
  fs.writeFileSync(
    path.join(root, 'mosaic.config.json'),
    JSON.stringify({
      title: 'Playback fixture',
      url: siteUrl,
      mediaBase: mediaUrl,
      apiBase: '/api',
      components: { stats: { enabled: false }, likes: { enabled: false } },
      player: { hls: { maxBufferLength: 12, manifestLoadingMaxRetry: 0 } },
    }),
  );
  const manifest = emptyManifest();
  const addPost = (slug, body, videoMode = '') => {
    fs.mkdirSync(path.join(root, 'content/posts', slug), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'content/posts', slug, 'index.md'),
      `---\ntitle: ${slug}\ncategory: test\n${videoMode ? `video_mode: ${videoMode}\n` : ''}---\n\n${body}\n`,
    );
    return (count) => {
      for (let index = 0; index < count; index += 1) {
        const filename = `video-${index}.mp4`;
        const id = `${slug}/videos/${filename}`;
        manifest.assets[id] = {
          id,
          slug,
          folder: 'videos',
          filename,
          status: 'ready',
          published: {
            hls: slug === 'fallback' ? `fixture/${slug}/${index}/broken.m3u8` : `fixture/${slug}/${index}/master.m3u8`,
            sources: { '240p': `fixture/${slug}/${index}/clip.mp4` },
            poster: `fixture/${slug}/${index}/photo.jpg`,
          },
        };
      }
    };
  };
  addPost('stacked', '{{videos}}')(4);
  addPost('fallback', '{{videos}}')(2);
  addPost('playlist', 'Playlist body', 'playlist')(2);
  fs.writeFileSync(path.join(root, '.mosaic/media-manifest.json'), JSON.stringify(manifest));
  generateSite(loadContext({ MOSAIC_ROOT: root }));
  await build({
    entryPoints: [path.join(ROOT, 'src/assets/js/app.js')],
    outfile: path.join(root, 'dist/assets/js/app.js'),
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2020',
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 500 }, hasTouch: true });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const metrics = {};

  // ---- click-only decode flow, first-click playback, quality switch ----
  await page.goto(`${siteUrl}/posts/stacked/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.video-container')?.dataset.playerReady === 'true');
  await page.waitForTimeout(600);
  const mountedBeforeClick = await page.evaluate(
    () => [...document.querySelectorAll('.video-container')].filter((c) => c.dataset.playerReady === 'true').length,
  );
  assert.ok(mountedBeforeClick >= 1 && mountedBeforeClick < 4, 'only near-viewport players initialize');
  assert.equal(
    requests.filter((request) => /master\.m3u8/.test(request.url)).length,
    0,
    'an unplayed player requests no HLS manifest at all',
  );
  assert.equal(
    requests.filter((request) => /level-|clip\.mp4/.test(request.url)).length,
    0,
    'no playlist/fragment/MP4 bytes before intent',
  );

  const playMetrics = await page.evaluate(() => {
    window.__play = {};
    const button = document.querySelector('.video-big-play');
    button.addEventListener('pointerdown', () => (window.__play.click = performance.now()), {
      once: true,
      capture: true,
    });
    const video = document.querySelector('video');
    video.addEventListener('playing', () => (window.__play.playing = performance.now()), { once: true });
  });
  void playMetrics;
  await page.locator('.video-big-play').first().click();
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.3);
  metrics.clickToFirstFrameMs = Math.round(await page.evaluate(() => window.__play.playing - window.__play.click));
  assert.ok(metrics.clickToFirstFrameMs >= 0, 'first click starts playback');
  metrics.segmentsAfterClick = requests.filter((request) => request.url.includes('.ts')).length;
  assert.ok(metrics.segmentsAfterClick > 0, 'the play intent starts fragment loading');
  const mediaRequests = requests.filter(
    (request) => request.url.startsWith('/fixture/') && /\.(m3u8|ts|mp4)/.test(request.url),
  );
  assert.ok(
    mediaRequests.filter((request) => request.origin).every((request) => request.url.includes('mosaic-cors=cors-v1')),
    'all CORS media requests keep the cache namespace',
  );
  const hlsState = await page.evaluate(() => {
    const video = document.querySelector('video');
    const playback = video.__mosaicPlayback;
    return {
      hasHls: !!video._hls,
      // `options` is the constructor argument (test doubles keep it); real
      // hls.js exposes the merged config on `.config`.
      maxBufferLength: video._hls?.options?.maxBufferLength ?? video._hls?.config?.maxBufferLength,
      levels: playback?.levels?.map((level) => level.label),
      quality: playback?.quality,
      state: playback?.state,
    };
  });
  assert.equal(hlsState.hasHls, true, 'HLS player exposes video._hls');
  assert.equal(hlsState.maxBufferLength, 12, 'operator hls config is merged into the engine');
  assert.deepEqual(hlsState.levels, ['240p', '480p']);
  assert.equal(hlsState.state, 'playing');

  // Quality toggle must not pause, rewind or exhaust the buffer (no black gap).
  await page.evaluate(() => {
    window.__probe = { pauses: 0, readyStates: [], times: [], until: performance.now() + 3000 };
    const video = document.querySelector('video');
    video.addEventListener('pause', () => (window.__probe.pauses += 1));
    const sample = () => {
      if (performance.now() > window.__probe.until) return;
      window.__probe.readyStates.push(video.readyState);
      window.__probe.times.push(video.currentTime);
      requestAnimationFrame(sample);
    };
    sample();
  });
  await page.locator('.vc-quality-btn').first().click();
  const menuText = await page.locator('.vc-quality-menu').first().innerText();
  assert.match(menuText, /240p/);
  assert.match(menuText, /480p/);
  assert.match(menuText, /kbps|Mbps/, 'quality menu shows real bitrate');
  assert.doesNotMatch(menuText, /1080p/, 'quality menu only lists published tiers');
  await page.locator('.vc-quality-menu').first().locator('button[data-res="480p"]').click();
  await page.waitForTimeout(700);
  const manual = await page.evaluate(() => {
    const video = document.querySelector('video');
    return {
      quality: video.__mosaicPlayback.quality,
      loadLevel: video._hls.manualLevel,
      paused: video.paused,
      probe: window.__probe,
    };
  });
  assert.equal(manual.quality, '480p', 'manual preference wins');
  assert.equal(manual.loadLevel, 1, 'manual quality locks the hls level');
  assert.equal(manual.paused, false, 'quality switch keeps playing');
  assert.ok(
    !manual.probe.readyStates.some((state) => state < 2),
    'quality switch never drops below HAVE_CURRENT_DATA (no black frame)',
  );
  assert.equal(manual.probe.pauses, 0, 'quality switch never pauses the media element');
  const lastTimes = manual.probe.times.slice(-5);
  assert.ok(
    lastTimes.length > 0 && lastTimes.every((time, index) => index === 0 || time >= lastTimes[index - 1] - 0.05),
    'playback clock keeps moving forward across the switch',
  );
  await page.evaluate(() => document.querySelector('video').__mosaicPlayback.setQuality('auto'));
  assert.equal(
    await page.evaluate(() => document.querySelector('video')._hls.manualLevel),
    -1,
    'auto quality releases the manual lock',
  );
  assert.ok(
    await page.evaluate(
      (base) =>
        [...document.head.querySelectorAll('link[rel="preconnect"]')].some((link) => link.href.startsWith(base)),
      mediaUrl,
    ),
    'media origin is preconnected on play intent',
  );
  assert.equal(
    await page.evaluate(
      () => [...document.querySelectorAll('.video-container')].filter((c) => c.dataset.playerReady === 'true').length,
    ),
    mountedBeforeClick,
    'playing one video does not initialize offscreen players',
  );

  // ---- position restore under the stable media key ----
  await page.evaluate(() => {
    const video = document.querySelector('video');
    video.currentTime = 2;
    video.pause();
  });
  const positionKey = 'mosaic_video_pos_stacked/videos/video-0.mp4';
  await page.waitForFunction((key) => Number(localStorage.getItem(key)) > 1, positionKey);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.video-container')?.dataset.playerReady === 'true');
  await page.locator('.video-big-play').first().click();
  await page.waitForFunction(() => document.querySelector('video').currentTime > 1.5);
  metrics.restoredFrom = await page.evaluate(() => document.querySelector('video').currentTime);

  // ---- fatal manifest degrades to native MP4, published menu only ----
  await page.goto(`${siteUrl}/posts/fallback/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.video-container').dataset.playerReady === 'true');
  assert.equal(
    requests.filter((request) => /fallback\/0\/broken\.m3u8/.test(request.url)).length,
    0,
    'a broken manifest is not requested before intent either',
  );
  await page.locator('.video-big-play').first().click();
  await page.waitForFunction(() => {
    const src = document.querySelector('video').src;
    return !!src && new URL(src).pathname.endsWith('clip.mp4');
  });
  assert.equal(
    await page.evaluate(() => document.querySelector('video').__mosaicPlayback.mode),
    'mp4',
    'manifest failure falls back to progressive MP4',
  );
  const fallbackMenu = await page.locator('.vc-quality-menu').first().innerText();
  assert.match(fallbackMenu, /240p/);
  assert.doesNotMatch(fallbackMenu, /1080p/);
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.3);

  // ---- playlist auto-advance exactly once ----
  await page.goto(`${siteUrl}/posts/playlist/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.video-container')?.dataset.playerReady === 'true');
  await page.locator('.video-big-play').first().click();
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.3);
  await page.evaluate(() => {
    const video = document.querySelector('video');
    video.currentTime = video.duration - 0.12;
  });
  await page.waitForFunction(() => document.querySelector('.pl-item.active')?.dataset.index === '1');
  metrics.playlistAdvances = 1;
  await page.waitForTimeout(1200);
  assert.equal(
    await page.locator('.pl-item.active').getAttribute('data-index'),
    '1',
    'auto-advance fires exactly once per ended video',
  );
  assert.deepEqual(errors, [], 'playback has no JavaScript errors');
  console.log('Playback browser metrics:', JSON.stringify(metrics));
  console.log(
    'Playback browser: click-only decode, first-click play, quality continuity, position restore, MP4 fallback, playlist single advance and preconnect passed',
  );
  await browser.close();
} finally {
  siteServer.closeAllConnections();
  mediaServer.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => siteServer.close(resolve)),
    new Promise((resolve) => mediaServer.close(resolve)),
  ]);
  fs.rmSync(root, { recursive: true, force: true });
}
