import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';
import { ROOT, loadContext } from '../scripts/lib/context.mjs';
import { generateSite } from '../scripts/site/generate.mjs';
import { emptyManifest } from '../shared/media-manifest.mjs';
import { stampApp } from '../scripts/lib/published-assets.mjs';

// Use actual HTTP servers: Playwright routing disables the cache and concealed the production failure.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-experience-'));
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/hls.json')));
const photo = Buffer.from(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/media.json'))).photo, 'base64');
const requests = [];
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, resolve));
  return `http://localhost:${server.address().port}`;
};
const mediaServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requests.push({ url: req.url, origin: req.headers.origin, range: req.headers.range });
  // Reproduce R2's cacheable no-Origin response without Vary, then its CORS response.
  const headers = { 'Cache-Control': 'public, max-age=3600' };
  if (req.headers.origin) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers.Vary = 'Origin';
  }
  const name = url.pathname.split('/').at(-1);
  let data;
  if (name === 'broken.m3u8') {
    res.writeHead(404, headers).end();
    return;
  }
  if (name === 'master.m3u8' || name === 'level.m3u8') {
    data = Buffer.from(name === 'master.m3u8' ? fixture.master : fixture.level);
    headers['Content-Type'] = 'application/vnd.apple.mpegurl';
  } else if (fixture.segments[name]) {
    data = Buffer.from(fixture.segments[name], 'base64');
    headers['Content-Type'] = 'video/mp2t';
  } else if (name === 'clip.mp4') {
    data = Buffer.from(fixture.video, 'base64');
    headers['Content-Type'] = 'video/mp4';
  } else if (name === 'photo.jpg') {
    data = photo;
    headers['Content-Type'] = 'image/jpeg';
  } else {
    res.writeHead(404).end();
    return;
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = Number(range[1]),
      end = Math.min(Number(range[2] || data.length - 1), data.length - 1);
    headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
    data = data.subarray(start, end + 1);
  }
  headers['Content-Length'] = data.length;
  headers['Accept-Ranges'] = 'bytes';
  res.writeHead(range ? 206 : 200, headers).end(data);
});
const mediaUrl = await listen(mediaServer);
let appDelay = 0;
const siteRequests = [];
const siteServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  siteRequests.push(url.pathname);
  let file = path.resolve(root, 'dist', '.' + url.pathname);
  if (!file.startsWith(path.join(root, 'dist') + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  const send = () => {
    res.writeHead(200, {
      'Content-Type':
        {
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.html': 'text/html',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.woff2': 'font/woff2',
        }[path.extname(file)] || 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
    });
    res.end(fs.readFileSync(file));
  };
  if (/\/assets\/js\/app(?:\.[a-f0-9]+)?\.js$/.test(url.pathname) && appDelay) setTimeout(send, appDelay);
  else send();
});
const siteUrl = await listen(siteServer);
try {
  fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mosaic'));
  fs.writeFileSync(
    path.join(root, 'mosaic.config.json'),
    JSON.stringify({
      title: 'Experience fixture',
      url: siteUrl,
      mediaBase: mediaUrl,
      components: { stats: { enabled: false }, likes: { enabled: false } },
      player: { hls: { manifestLoadingMaxRetry: 0, maxBufferLength: 4 } },
    }),
  );
  const manifest = emptyManifest();
  for (const slug of ['playback', 'early', 'fallback', 'native', 'native-early']) {
    fs.mkdirSync(path.join(root, 'content/posts', slug), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'content/posts', slug, 'index.md'),
      `---\ntitle: ${slug}\ncategory: test\n---\n\n{{videos}}\n`,
    );
    for (const filename of ['a.mp4', 'b.mp4']) {
      const id = `${slug}/videos/${filename}`;
      manifest.assets[id] = {
        id,
        slug,
        folder: 'videos',
        filename,
        status: 'ready',
        published: {
          ...(slug.startsWith('native')
            ? {}
            : { hls: `fixture/${slug}/${slug === 'fallback' ? 'broken' : 'master'}.m3u8` }),
          sources: { '240p': `fixture/${slug}/clip.mp4` },
          poster: 'fixture/photo.jpg',
        },
      };
    }
  }
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
  const publishedApp = stampApp(path.join(root, 'dist'));
  for (const engine of [webkit, chromium]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(30000);
      console.log(`Cache-enabled playback regression: ${engine.name()}`);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const engineStart = requests.length;
      // Windows WebKit's MSE decoder is not Safari. Exercise real native MP4 here;
      // Chromium runs actual HLS, and frontend-local separately covers WebKit HLS controls.
      const slug = engine === chromium ? 'playback' : 'native';
      await page.goto(`${siteUrl}/posts/${slug}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('.video-container').dataset.playerReady === 'true');
      const start = requests.length;
      // Prime every old URL as a cacheable opaque response, exactly as native preload did.
      await page.evaluate(
        async ({ base, slug, segments }) => {
          for (const name of ['master.m3u8', 'level.m3u8', ...segments, 'clip.mp4'])
            await fetch(`${base}/fixture/${slug}/${name}`, { mode: 'no-cors', signal: AbortSignal.timeout(3000) });
        },
        { base: mediaUrl, slug, segments: Object.keys(fixture.segments) },
      );
      const primed = requests.slice(start);
      assert.ok(
        primed.every((r) => !r.origin),
        'old media cache was primed without Origin',
      );
      const segmentCount = requests.filter((r) => r.url.includes('.ts') && r.origin).length;
      await page.waitForTimeout(200);
      assert.equal(
        requests.filter((r) => r.url.includes('.ts') && r.origin).length,
        segmentCount,
        'paused players do not download HLS segments',
      );
      assert.equal(await page.locator('video').first().getAttribute('crossorigin'), 'anonymous');
      assert.equal(await page.locator('video').first().getAttribute('preload'), 'none');
      await page.locator('.video-big-play').first().click();
      await page.waitForFunction(() => document.querySelector('video').currentTime > 0.3, null, { timeout: 10000 });
      const served = requests
        .slice(engineStart)
        .filter((r) => r.url.includes(`/fixture/${slug}/`) && !primed.includes(r));
      assert.ok(
        served.length && served.every((r) => r.url.includes('mosaic-cors=cors-v1')),
        'CORS namespace applies to manifests, segments and MP4',
      );
      if (engine === chromium)
        assert.ok(
          served.every((r) => r.origin),
          'HLS requests use CORS',
        );
      await page.evaluate(() => {
        const v = document.querySelector('video');
        v.currentTime = 2;
        v.pause();
      });
      await page.waitForFunction(
        (slug) => Number(localStorage.getItem(`mosaic_video_pos_${slug}/videos/a.mp4`)) > 1,
        slug,
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('.video-container').dataset.playerReady === 'true');
      await page.locator('.video-big-play').first().click();
      await page.waitForFunction(() => document.querySelector('video').currentTime > 1.5);
      assert.equal(
        await page
          .locator('video')
          .nth(1)
          .evaluate((v) => v.paused),
        true,
        'unused player remains paused',
      );
      console.log(
        `${engine.name()}: real ${engine === chromium ? 'HLS' : 'MP4'} plays with primed and warm HTTP cache; position resumes`,
      );
      appDelay = 1200;
      const navigated = page.goto(`${siteUrl}/posts/${engine === chromium ? 'early' : 'native-early'}/`, {
        waitUntil: 'commit',
      });
      await navigated;
      await page.locator('.video-big-play').first().click();
      await page.waitForFunction(() => document.querySelector('video').currentTime > 0.3, null, { timeout: 10000 });
      appDelay = 0;
      const modules = await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .filter((r) => r.name.includes('/assets/js/') && !r.name.includes('/vendor/'))
          .map((r) => new URL(r.name).pathname),
      );
      assert.deepEqual(modules, ['/assets/js/' + publishedApp], 'published app has one versioned module request');
      console.log(`${engine.name()}: click before delayed scripts is replayed; one app request`);
      if (engine === chromium) {
        await page.goto(`${siteUrl}/posts/fallback/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('video').src.includes('clip.mp4'));
        await page.locator('.video-big-play').first().click();
        await page.waitForFunction(() => document.querySelector('video').currentTime > 0.3);
      }
      await page.goto(`${siteUrl}/posts/native/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('.video-container').dataset.playerReady === 'true');
      assert.ok(
        (await page.locator('video').first().getAttribute('src')).includes('clip.mp4'),
        'only published low tier is selected on desktop',
      );
      await page.locator('.video-big-play').first().click();
      await page.waitForFunction(() => document.querySelector('video').currentTime > 0.3);
      assert.deepEqual(errors, [], 'playback has no JavaScript errors');
      // Small MP4s may be fetched whole by WebKit; verify ranged CORS transport explicitly.
      const range = await page.evaluate(async (url) => {
        const response = await fetch(url, { headers: { Range: 'bytes=0-127' } });
        return {
          status: response.status,
          bytes: (await response.arrayBuffer()).byteLength,
        };
      }, `${mediaUrl}/fixture/native/clip.mp4?mosaic-cors=cors-v1&range-check=1`);
      assert.equal(range.status, 206);
      assert.equal(range.bytes, 128);
      console.log(
        `${engine.name()}: ${engine === chromium ? 'failed manifest recovers to MP4; ' : ''}low-tier native/range playback passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  siteServer.closeAllConnections();
  mediaServer.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => siteServer.close(resolve)),
    new Promise((resolve) => mediaServer.close(resolve)),
  ]);
  fs.rmSync(root, { recursive: true, force: true });
}
