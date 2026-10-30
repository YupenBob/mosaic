import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { stageAdmin } from '../scripts/lib/published-assets.mjs';
import { chromium } from 'playwright';
import { ROOT } from '../scripts/lib/context.mjs';
import { normalizeConfig } from '../shared/config.mjs';
import { serveDirectory } from './helpers/static-server.mjs';
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-admin-'));
stageAdmin(path.join(ROOT, 'cloud-admin'), path.join(staged, 'dist'), staged);
const server = await serveDirectory(path.join(staged, 'dist'));
const browser = await chromium.launch({ headless: true });
const requests = [],
  errors = [];
let savedPost = null;
const config = normalizeConfig({
  title: 'Fixture',
  url: server.url,
  mediaBase: server.url,
  admin: { jobPollMs: 100 },
  theme: { defaultMode: 'light' },
});
let job = {
  id: 'fixture-job',
  slug: 'fixture',
  filename: 'clip.mp4',
  status: 'failed',
  error: 'Fixture upload failure',
};
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== server.url) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const pathname = url.pathname.slice(4);
    requests.push(pathname);
    if (pathname === '/posts' && route.request().method() === 'POST') {
      savedPost = JSON.parse(route.request().postData() || '{}');
    }
    let body = { ok: true };
    if (pathname === '/auth/login') body = { token: 'fixture-token' };
    else if (pathname === '/config' && route.request().method() === 'PUT') {
      requests.push('/config:PUT');
      body = { ok: true };
    } else if (pathname === '/config') body = config;
    else if (pathname === '/dirty') body = { dirty: true, count: 2, last: new Date().toISOString() };
    else if (pathname === '/media-jobs') body = { jobs: [job] };
    else if (pathname.endsWith('/retry')) {
      job = { ...job, status: 'pending', error: '' };
    } else if (pathname.endsWith('/cancel')) {
      job = { ...job, status: 'cancelled' };
    } else if (pathname === '/build/status') body = { status: 'unknown' };
    else if (pathname === '/build/history') body = { runs: [] };
    else if (pathname === '/stats') body = { posts: 1, categories: 1, tags: 1 };
    else if (pathname === '/stats/traffic') body = { total: 1, byDay: [], byCategory: [], byTag: [], top5: [] };
    else if (pathname === '/stats/posts') body = { stats: {} };
    else if (pathname.startsWith('/health')) body = { status: 'ok', latency: 1 };
    else if (pathname === '/disk') body = { sizeMB: 1, objects: 1, cost: 0 };
    else if (pathname === '/taxonomy')
      body = {
        categories: [{ name: 'Fixture', slug: 'fixture', count: 1 }],
        tags: [{ name: 'test', slug: 'test', count: 1 }],
      };
    else if (pathname === '/posts')
      body = {
        posts: [
          {
            slug: 'fixture',
            title: 'Fixture post',
            category: 'Fixture',
            tags: ['test'],
            date: '2026-01-01',
            cover: '',
          },
        ],
        total: 1,
      };
    else if (pathname.startsWith('/posts/'))
      body = {
        slug: 'fixture',
        frontMatter: { title: 'Fixture post', category: 'Fixture', tags: ['test'] },
        body: 'Fixture body',
        sha: 'fixture-sha',
      };
    else if (pathname.includes('/list')) body = { photos: [], videos: [], music: [], covers: [] };
    else if (pathname === '/trash') body = { items: [] };
    else if (pathname === '/drafts' && route.request().method() === 'GET')
      body = {
        drafts: [
          {
            id: 'drf_0123456789abcdefghjkmnpq',
            title: 'Fixture draft',
            slug: 'fixture-draft',
            revision: 1,
            updatedAt: new Date().toISOString(),
            mediaCount: 1,
          },
        ],
      };
    else if (pathname === '/drafts' && route.request().method() === 'POST')
      body = {
        id: 'drf_0123456789abcdefghjkmnpq',
        revision: 1,
        updatedAt: new Date().toISOString(),
        ...JSON.parse(route.request().postData() || '{}'),
      };
    else if (pathname === '/drafts/drf_0123456789abcdefghjkmnpq' && route.request().method() === 'GET')
      body = {
        id: 'drf_0123456789abcdefghjkmnpq',
        revision: 2,
        slug: 'fixture-draft',
        title: 'Fixture cloud draft',
        body: 'Cloud draft body',
        frontMatter: { title: 'Fixture cloud draft', category: 'Fixture' },
        media: { gallery: [], videos: [], music: [], cover: null },
        baseSha: null,
        updatedAt: new Date().toISOString(),
      };
    else if (pathname.endsWith('/publish') && route.request().method() === 'POST')
      body = { ok: true, slug: 'fixture-draft', sha: 'published-sha' };
    else if (pathname === '/history' && route.request().method() === 'GET')
      body = {
        commits: [
          {
            sha: 'a'.repeat(40),
            shortSha: 'aaaaaaa',
            message: 'Fixture edit <img src=x onerror="window.__historyXss=1">',
            author: 'Fixture',
            date: new Date().toISOString(),
          },
        ],
      };
    else if (pathname === '/history/' + 'a'.repeat(40) && route.request().method() === 'GET')
      body = {
        sha: 'a'.repeat(40),
        shortSha: 'aaaaaaa',
        message: 'Fixture edit',
        author: 'Fixture',
        date: new Date().toISOString(),
        files: [
          {
            filename: 'content/posts/fixture/index.md',
            status: 'modified',
            additions: 1,
            deletions: 1,
            patch: '@@ -1 +1 @@',
          },
        ],
      };
    else if (pathname.endsWith('/restore') && route.request().method() === 'POST') body = { ok: true, files: [] };
    else if (pathname === '/themes' && route.request().method() === 'GET')
      body = {
        themes: [
          {
            id: 'default',
            name: 'Mosaic Default',
            version: '1.0.0',
            description: 'Built-in theme',
            current: true,
            values: { accent: 'blue', defaultMode: 'auto', showThemeMenu: true, allowVisitorToggle: true },
            options: {
              accent: { type: 'select', default: 'blue', options: ['blue', 'rose'], label: '强调色' },
              showThemeMenu: { type: 'boolean', default: true, label: '显示主题菜单' },
            },
          },
          {
            id: 'starter',
            name: 'Starter',
            version: '1.0.0',
            description: 'Tiny theme',
            current: false,
            values: {},
            options: { accent: { type: 'color', default: '#4361ee', label: '强调色' } },
          },
        ],
        current: { package: 'default', options: {} },
      };
    else if (pathname === '/themes/apply' && route.request().method() === 'POST')
      body = { ok: true, themePackage: 'starter', themeOptions: {} };
    else if (pathname === '/media/interpolate' && route.request().method() === 'POST')
      body = { ok: true, enqueued: 1, tasks: [], skipped: [] };
    else if (pathname === '/previews' && route.request().method() === 'POST')
      body = {
        previewId: 'prv_0123456789abcdefghjkmnpq',
        token: 'preview-token',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        status: 'queued',
      };
    else if (pathname === '/previews/prv_0123456789abcdefghjkmnpq')
      body = { id: 'prv_0123456789abcdefghjkmnpq', status: 'ready' };
    else if (pathname.startsWith('/drafts/drf_') && route.request().method() === 'PUT') {
      const input = JSON.parse(route.request().postData() || '{}');
      body = {
        id: 'drf_0123456789abcdefghjkmnpq',
        revision: (Number(input.revision) || 1) + 1,
        updatedAt: new Date().toISOString(),
        ...input,
      };
    } else if (pathname === '/assets')
      body = {
        assets: [
          {
            id: 'ast_0123456789abcdefghjkmnpq',
            filename: 'library-photo.jpg',
            folder: 'photos',
            status: 'ready',
            published: true,
          },
          {
            id: 'ast_0123456789abcdefghjkmnpr',
            filename: 'clip.mp4',
            folder: 'videos',
            status: 'ready',
            published: true,
            sourceAvailable: true,
          },
        ],
        total: 2,
      };
    await route.fulfill({ json: body });
  });
  await page.goto(server.url);
  await page.locator('#login-password').fill('fixture-password');
  await page.locator('#login-btn').click();
  await page.waitForFunction(() => document.querySelector('#app').style.display === 'flex');
  await page.locator('#app-status').waitFor({ state: 'visible' });
  assert.match(await page.locator('#app-status').innerText(), /未上线/, 'status chip summarizes unbuilt changes');
  await page.click('#account-btn');
  await page.locator('#account-menu').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#account-theme-options button').count(), 3, 'account menu owns appearance');
  await page.keyboard.press('Escape');
  await page.locator('#account-menu').waitFor({ state: 'hidden' });

  // Editor can attach a v2 library asset without a slug-bound media list.
  await page.evaluate(() => {
    location.hash = 'editor&slug=fixture';
  });
  await page.locator('[data-open-asset-picker]').waitFor();
  await page.locator('[data-open-asset-picker]').click();
  await page.locator('.asset-pick').first().click();
  await page.locator('.modal-overlay .btn-primary').click();
  await page.locator('.modal-overlay').waitFor({ state: 'hidden' });
  assert.ok(
    (await page.locator('#fm-body').inputValue()).includes('{{photo:0}}'),
    'picked library asset inserts a photo placeholder',
  );
  assert.equal(
    await page.locator('#v2-media-list .v2-media-chip').count(),
    1,
    'picked library asset is tracked in the post media refs',
  );
  await page.evaluate(() => window.doSavePost());
  await page.waitForTimeout(1200);
  assert.equal(savedPost?.frontMatter?.media?.gallery?.length, 1, 'save carries the picked library asset');

  await page.evaluate(() => {
    location.hash = 'library';
  });
  await page.locator('.asset-card').first().waitFor();
  await page.locator('.asset-card').first().click();
  await page.locator('.asset-detail').waitFor();
  assert.ok((await page.locator('.asset-detail').innerText()).includes('library-photo.jpg'), 'asset detail opens');
  await page.locator('.modal-overlay .btn-secondary').first().click();

  await page.evaluate(() => {
    location.hash = 'history';
  });
  await page.locator('.history-row').first().waitFor();
  await page.locator('.history-row').first().click();
  await page.locator('.modal-title').waitFor();
  assert.equal(await page.evaluate(() => window.__historyXss), undefined, 'commit messages cannot execute scripts');
  await page.locator('.modal-overlay .btn-secondary').first().click();

  // Draft mode: save goes to R2, publish writes Git and returns to the list.
  await page.evaluate(() => {
    location.hash = 'editor&draft=drf_0123456789abcdefghjkmnpq';
  });
  await page.locator('#fm-title').waitFor();
  assert.equal(await page.locator('.page-header h1').innerText(), '草稿');
  assert.equal(await page.locator('#fm-title').inputValue(), 'Fixture cloud draft');
  await page.evaluate(() => window.saveDraftNow());
  await page.waitForTimeout(300);
  await page.evaluate(() => window.openPreview());
  await page.waitForTimeout(500);
  assert.ok(requests.includes('/previews'), 'preview create request is sent');
  assert.ok(requests.includes('/previews/prv_0123456789abcdefghjkmnpq'), 'preview status is polled');
  await page.evaluate(() => window.publishDraft());
  await page.waitForTimeout(500);
  assert.ok(
    requests.includes('/drafts/drf_0123456789abcdefghjkmnpq/publish'),
    'draft publish hits the publish endpoint',
  );

  // Mobile posts are cards, never a squeezed table.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    location.hash = 'posts';
  });
  await page.locator('.admin-post-card').first().waitFor();
  assert.equal(await page.locator('#posts-table-view').isVisible(), false, 'table hides on mobile');
  assert.equal(await page.locator('#posts-cards-view').isVisible(), true, 'cards show on mobile');
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    'mobile posts do not scroll horizontally',
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    location.hash = 'tasks';
  });
  await page.locator('[data-job-action="retry"]').waitFor();
  await page.locator('[data-job-action="retry"]').click();
  await page.locator('[data-job-action="cancel"]').waitFor();
  await page.locator('[data-job-action="cancel"]').click();
  await page.locator('[data-job-action="retry"]').waitFor();
  await page.evaluate(() => {
    location.hash = 'posts';
  });
  await page.locator('#main-content .post-list, #main-content h1').first().waitFor();
  await page.waitForTimeout(300);
  const polls = requests.filter((route) => route === '/media-jobs').length;
  await page.waitForTimeout(350);
  assert.equal(
    requests.filter((route) => route === '/media-jobs').length,
    polls,
    'media polling stops when leaving the page',
  );
  // Regression (v2.1): the documented default apiBase is a relative path
  // ("/api"); a native <input type="url"> used to block every config save.
  await page.evaluate(() => {
    location.hash = 'config';
  });
  await page.locator('#main-content .page-anim').first().waitFor();
  await page.locator('.page-header .btn-primary').click();
  await page.waitForTimeout(400);
  assert.ok(requests.includes('/config:PUT'), 'config saves with the default relative apiBase');
  assert.equal(await page.locator('.config-field.has-error').count(), 0, 'no validation errors for /api');

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    for (const route of [
      'dashboard',
      'posts',
      'drafts',
      'editor&slug=fixture',
      'library',
      'enhance',
      'themes',
      'history',
      'build',
      'tasks',
      'config',
      'taxonomy',
      'cleanup',
    ]) {
      await page.evaluate((value) => {
        location.hash = value;
      }, route);
      await page.waitForFunction(
        (page) => document.querySelector('.nav-item.active')?.dataset.page === page,
        route.split('&')[0],
      );
      await page.waitForTimeout(350);
      await page.locator('#main-content .page-anim').first().waitFor();
      await page.evaluate(async () => {
        const element = document.querySelector('#main-content .page-anim');
        await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})));
      });
      if (process.env.ADMIN_SHOTS) {
        const shotDir = process.env.ADMIN_SHOTS;
        fs.mkdirSync(shotDir, { recursive: true });
        await page.screenshot({
          path: path.join(shotDir, `${route.replace(/[^a-z0-9]+/gi, '-')}-${theme}.png`),
          fullPage: true,
        });
      }
      await page.addScriptTag({ path: path.join(ROOT, 'node_modules/axe-core/axe.min.js') });
      const violations = await page.evaluate(async () =>
        (await window.axe.run(document)).violations.map((item) => ({
          id: item.id,
          impact: item.impact,
          targets: item.nodes.map((node) => node.target),
        })),
      );
      assert.deepEqual(violations, [], `${theme} / ${route} accessibility`);
    }
  }
  assert.deepEqual(errors, [], 'all admin routes must render without JavaScript errors');
  assert.ok(!requests.includes('/build/done'), 'browser polling cannot acknowledge a deployment');
  console.log(
    'Local admin: authentication, editor/routes, media retry/cancel, polling cleanup and 13 pages × 2 themes accessibility passed',
  );
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(staged, { recursive: true, force: true });
}
