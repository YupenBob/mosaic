import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { stageAdmin } from '../scripts/lib/published-assets.mjs';
import { chromium } from 'playwright';
import { ROOT } from '../scripts/lib/context.mjs';
import { normalizeConfig } from '../shared/config.mjs';
import { serveDirectory } from './helpers/static-server.mjs';
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-admin-experience-'));
stageAdmin(path.join(ROOT, 'cloud-admin'), path.join(staged, 'dist'), staged);
const server = await serveDirectory(path.join(staged, 'dist'));
const browser = await chromium.launch({ headless: true });
const requests = [],
  errors = [];
const config = normalizeConfig({
  url: server.url,
  mediaBase: server.url,
  admin: { jobPollMs: 100, requestTimeoutMs: 600 },
  upload: { multipartThreshold: 512 },
});
let confirmations = 0,
  jobStatus = 'pending',
  metricFailed = false,
  emptySite = false;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('mosaic_admin_token', 'fixture-token'));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== server.url) return route.abort();
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/put/')) return route.continue();
    const name = url.pathname.replace(/^\/api/, '');
    requests.push(name);
    let body = { ok: true },
      status = 200;
    if (name === '/config') {
      await wait(400);
      body = config;
    } else if (name === '/dirty') body = { dirty: false };
    else if (name === '/build/status') body = { status: 'unknown' };
    else if (name === '/stats')
      body = { posts: emptySite ? 0 : 3, categories: emptySite ? 0 : 2, tags: emptySite ? 0 : 1 };
    else if (name === '/stats/traffic') {
      await wait(metricFailed ? 100 : 500);
      status = metricFailed ? 200 : 503;
      metricFailed = true;
      body =
        status === 200
          ? {
              total: emptySite ? 0 : 10,
              byDay: emptySite ? [] : [{ date: '2026-10-03', count: 10 }],
              top5: [],
            }
          : { error: 'fixture slow service' };
    } else if (name === '/stats/posts') {
      await wait(1200);
      body = { stats: {} };
    } else if (name === '/health/github' && emptySite) {
      status = 503;
      body = { error: 'fixture health unavailable' };
    } else if (name.startsWith('/health')) body = { status: 'ok' };
    else if (name === '/disk') body = { sizeMB: 1, objects: 1, cost: 0 };
    else if (name === '/taxonomy')
      body = {
        categories: emptySite
          ? []
          : [
              { name: 'parent/child', count: 2 },
              { name: 'other', count: 1 },
            ],
        tags: emptySite ? [] : [{ name: 'tag', count: 1 }],
      };
    else if (name === '/posts')
      body = {
        posts: emptySite
          ? []
          : [
              { slug: 'fixture', title: 'Apple', category: 'parent/child', cover: server.url + '/actual-cover.webp' },
              { slug: 'second', title: 'Apple elsewhere', category: 'other' },
              { slug: 'third', title: 'Banana', category: 'parent/child' },
            ],
      };
    else if (name === '/posts/fixture')
      body = {
        slug: 'fixture',
        frontMatter: { title: 'Apple', category: 'parent/child', cover: 'cover.jpg' },
        body: 'Editable text\n\n{{photo:0}}\n',
        sha: 'fixture-sha',
      };
    else if (name.endsWith('/list'))
      body = {
        photos: [
          {
            name: 'photo.jpg',
            url: server.url + '/original-photo.jpg',
            previewUrl: server.url + '/assets/logo.svg',
            status: 'pending',
            taskId: 'photo-job',
          },
        ],
        videos: [
          { name: 'a.mp4', previewUrl: server.url + '/poster-a.jpg', status: 'ready' },
          { name: 'b.mp4', previewUrl: server.url + '/poster-b.jpg', status: 'ready' },
        ],
        music: [],
        covers: [
          {
            name: 'cover.jpg',
            url: '',
            previewUrl: server.url + '/orphan-cover.jpg',
            status: 'ready',
            published: true,
          },
        ],
      };
    else if (name === '/upload/presign') {
      const { filename } = route.request().postDataJSON();
      if (filename === 'direct.mp4') {
        status = 503;
        body = { error: 'presign unavailable' };
      } else body = { url: server.url + '/put/' + filename };
    } else if (name.startsWith('/upload/complete/')) {
      confirmations++;
      if (confirmations === 1) {
        status = 503;
        body = { error: 'confirmation failed' };
      } else body = { taskId: 'upload-job', status: 'pending' };
    } else if (name.startsWith('/upload/direct/')) body = { taskId: 'direct-job', status: 'pending' };
    else if (name === '/upload/multipart/start')
      body = {
        uploadId: 'mp-fixture',
        partSize: 400,
        partCount: 4,
        parts: [1, 2, 3, 4].map((n) => ({ partNumber: n, url: server.url + '/put/part-' + n })),
      };
    else if (name === '/upload/multipart/complete') {
      await wait(250);
      body = { taskId: 'multipart-job', status: 'pending' };
    } else if (name.startsWith('/media-jobs/')) {
      if (name.endsWith('/retry')) {
        jobStatus = 'pending';
        body = { ok: true };
      } else if (name.endsWith('/cancel')) body = { ok: true };
      else
        body = {
          id: name.split('/').at(-1),
          status: jobStatus,
          error: jobStatus === 'failed' ? 'fixture encode failure' : '',
        };
    }
    if (name === '/put/clip.mp4') await wait(100);
    await route.fulfill({ json: body, status }).catch(() => {});
  });
  const started = Date.now();
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.locator('[onclick="location.hash=\'editor\'"]').first().waitFor();
  const shellMs = Date.now() - started;
  assert.ok(shellMs < 1200, 'dashboard actions render before slow statistics');
  await page.evaluate(() => {
    window.fixtureActionNode = document.querySelector('.page-header-actions .btn-primary');
  });
  await page.locator('[data-metrics-retry]').waitFor();
  assert.equal(requests.filter((r) => r === '/config').length, 1, 'startup shares configuration request');
  assert.equal(
    await page.evaluate(
      () =>
        performance
          .getEntriesByType('resource')
          .filter((r) => /\/(js|src)\//.test(r.name) && !r.name.includes('/vendor/')).length,
    ),
    1,
    'published admin loads one application module',
  );
  console.log(`Admin slow service: actions available in ${shellMs}ms; failed metrics allow retry; one config request`);
  await page.locator('[data-dashboard-site-link] a').waitFor();
  assert.equal(await page.locator('[data-dashboard-site-link] a').getAttribute('href'), server.url);
  assert.ok(!(await page.locator('.page-subtitle').innerText()).includes('加载'), 'settled health clears loading text');
  await page.waitForFunction(() => !!window.Chart?.getChart(document.querySelector('#chart-categories')));
  await page.evaluate(() => {
    window.fixtureCategoryChart = window.Chart.getChart(document.querySelector('#chart-categories'));
  });
  await page.locator('[data-metrics-retry]').click();
  await page.waitForFunction(
    () => window.Chart?.getChart(document.querySelector('#chart-traffic'))?.data.datasets[0].data[0] === 10,
  );
  assert.equal(await page.evaluate(() => window.fixtureCategoryChart.ctx), null, 'superseded charts are destroyed');
  assert.equal(await page.evaluate(() => Object.keys(window.Chart.instances).length), 3);
  assert.equal(
    await page.evaluate(() => window.fixtureActionNode === document.querySelector('.page-header-actions .btn-primary')),
    true,
    'metric refresh keeps action nodes',
  );
  console.log(
    'Admin dashboard: late traffic restores charts, health settles, site link appears and chart instances stay bounded',
  );
  await page.evaluate(() => (location.hash = 'posts'));
  await page.locator('#post-search').waitFor();
  assert.equal(
    await page.evaluate(() => Object.keys(window.Chart.instances).length),
    0,
    'leaving dashboard destroys charts',
  );
  await page.locator('#post-search').fill('Apple');
  await page.locator('#post-cat-filter').selectOption('parent/child');
  await wait(250);
  assert.equal(await page.locator('#posts-table tbody tr:visible').count(), 1, 'search and category apply together');
  await page.locator('[data-view="cards"]').click();
  assert.equal(
    await page.locator('.admin-post-card img').first().getAttribute('src'),
    server.url + '/actual-cover.webp',
  );
  await page.evaluate(() => (location.hash = 'editor&slug=fixture'));
  await page.locator('#existing-media .media-grid').first().waitFor();
  await page.waitForFunction(() => !!document.querySelector('#cover-preview img'));
  assert.equal(await page.locator('#cover-preview img').getAttribute('src'), server.url + '/orphan-cover.jpg');
  await page.locator('.fm-text-block').first().fill('Keep my text and cursor');
  await page.evaluate(() => {
    window.fixtureTextNode = document.querySelector('.fm-text-block');
  });
  await wait(350);
  assert.equal(
    await page.evaluate(
      () =>
        window.fixtureTextNode === document.querySelector('.fm-text-block') &&
        document.activeElement === window.fixtureTextNode,
    ),
    true,
    'media polling preserves the focused textarea node',
  );
  assert.equal(await page.locator('#fm-body').inputValue(), 'Keep my text and cursor\n\n{{photo:0}}\n');
  assert.equal(await page.locator('.fm-media-single').getAttribute('src'), server.url + '/assets/logo.svg');
  await page.locator('[onclick="window.openCoverPicker()"]').click();
  await page.locator('[onclick="pickCover(\'video:1\')"]').click();
  assert.equal(await page.locator('#fm-cover').inputValue(), 'video:1');
  assert.equal(await page.locator('#cover-preview img').getAttribute('src'), server.url + '/poster-b.jpg');
  await page.evaluate(() => (location.hash = 'posts'));
  await page.locator('.modal-overlay').waitFor({ state: 'visible' });
  assert.ok((await page.evaluate(() => location.hash)).startsWith('#editor'), 'cover edit activates unsaved guard');
  await page.locator('.modal-overlay .btn-secondary').click();
  await page.locator('.modal-overlay').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#fm-cover').inputValue(), 'video:1', 'cancel keeps the chosen cover');
  await page
    .locator('#editor-media-input')
    .setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(100) });
  const row = page.locator('.upload-item').first();
  await row.locator('.upload-item-actions button').first().waitFor({ state: 'visible' });
  assert.equal(requests.filter((r) => r === '/put/clip.mp4').length, 1);
  assert.equal(
    requests.filter((r) => r.startsWith('/upload/direct/')).length,
    0,
    'successful PUT is never repeated through direct fallback',
  );
  await row.locator('.upload-item-actions button').first().click();
  await page.waitForFunction(() => document.querySelector('.upload-item').dataset.taskId === 'upload-job');
  assert.equal(confirmations, 2);
  assert.equal(requests.filter((r) => r === '/put/clip.mp4').length, 1, 'retry confirms the existing file');
  await page.waitForFunction(() => document.querySelector('.upload-item-meta').textContent.includes('排队中'));
  jobStatus = 'failed';
  await row.locator('.upload-item-actions button').first().waitFor({ state: 'visible' });
  await row.locator('.upload-item-actions button').first().click();
  await page.waitForFunction(() => document.querySelector('.upload-item-meta').textContent.includes('排队中'));
  assert.equal(requests.filter((r) => r === '/media-jobs/upload-job/retry').length, 1);
  assert.equal(confirmations, 2, 'processing retry does not confirm/upload again');
  await page
    .locator('#editor-media-input')
    .setInputFiles({ name: 'large.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(1280) });
  await page.waitForFunction(() => !!document.querySelector('[data-task-id="multipart-job"]'));
  assert.equal(requests.filter((r) => r.startsWith('/put/part-')).length, 4);
  await page
    .locator('#editor-media-input')
    .setInputFiles({ name: 'direct.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(100) });
  await page.waitForFunction(() => !!document.querySelector('[data-task-id="direct-job"]'));
  await page.evaluate(() => (location.hash = 'posts'));
  await page.locator('.modal-overlay .btn-primary').click();
  await page.locator('#post-search').waitFor();
  await wait(250);
  const polls = requests.filter((r) => r.startsWith('/media-jobs/') && !r.endsWith('/retry')).length;
  await wait(350);
  assert.equal(
    requests.filter((r) => r.startsWith('/media-jobs/') && !r.endsWith('/retry')).length,
    polls,
    'uploaded task polling stops after leaving editor',
  );
  assert.equal(
    requests.filter((r) => r.endsWith('/cancel')).length,
    0,
    'leaving the editor does not cancel confirmed processing',
  );
  emptySite = true;
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-dashboard-quickstart] .quickstart-card').waitFor();
  assert.equal(await page.locator('.dash-cards .dash-big-num').first().innerText(), '0');
  await page.waitForFunction(() => !document.querySelector('.page-subtitle').textContent.includes('加载'));
  assert.equal(
    await page.locator('.dash-health-dot.down').count(),
    1,
    'failed health settles instead of loading forever',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Admin experience: combined filters, actual/orphan covers, second video selection, cursor preservation, three upload paths, acknowledgement/processing retry and polling disposal passed',
  );
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(staged, { recursive: true, force: true });
}
