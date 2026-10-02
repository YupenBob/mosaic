import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../scripts/lib/context.mjs';
import { normalizeConfig } from '../shared/config.mjs';
import { serveDirectory } from './helpers/static-server.mjs';
const server = await serveDirectory(path.join(ROOT, 'cloud-admin'));
const browser = await chromium.launch({ headless: true });
const requests = [],
  errors = [];
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
    let body = { ok: true };
    if (pathname === '/auth/login') body = { token: 'fixture-token' };
    else if (pathname === '/config') body = config;
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
    await route.fulfill({ json: body });
  });
  await page.goto(server.url);
  await page.locator('#login-password').fill('fixture-password');
  await page.locator('#login-btn').click();
  await page.waitForFunction(() => document.querySelector('#app').style.display === 'flex');
  await page.evaluate(() => {
    location.hash = 'build';
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
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    for (const route of ['dashboard', 'posts', 'editor&slug=fixture', 'build', 'config', 'taxonomy', 'cleanup']) {
      await page.evaluate((value) => {
        location.hash = value;
      }, route);
      await page.waitForTimeout(350);
      await page.locator('#main-content .page-anim').first().waitFor();
      await page.evaluate(async () => {
        const element = document.querySelector('#main-content .page-anim');
        await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})));
      });
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
    'Local admin: authentication, editor/routes, media retry/cancel, polling cleanup and 7 pages × 2 themes accessibility passed',
  );
} finally {
  await browser.close();
  await server.close();
}
