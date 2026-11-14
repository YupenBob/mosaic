/**
 * Production admin journeys (read-only).
 *
 * Requires MOSAIC_ADMIN_PASSWORD. The runner's admin-prod target installs a
 * route guard that blocks every write except auth login/logout; a journey
 * asserting zero attempts proves the panel stays read-only in production.
 */
import { defineJourney, waitFor } from '../lib/journey.mjs';

export const area = 'admin';
/** only runs against the live admin with the read-only guard */
export const targets = ['admin-prod'];

const NAV_PAGES = [
  'dashboard',
  'posts',
  'drafts',
  'editor',
  'library',
  'taxonomy',
  'themes',
  'enhance',
  'build',
  'config',
  'history',
  'tasks',
  'cleanup',
  'trash',
];

async function login(t) {
  const password = process.env.MOSAIC_ADMIN_PASSWORD;
  t.assert(Boolean(password), 'MOSAIC_ADMIN_PASSWORD must be set for admin-prod journeys');
  await t.goto('/');
  await t.page.locator('#login-screen').waitFor({ state: 'visible', timeout: 30000 });
  await t.page.locator('#login-password').fill(password);
  await t.page.locator('#login-btn').click();
  await waitFor(async () => t.page.locator('#app').isVisible(), { timeout: 30000, message: 'admin app visible' });
  await waitFor(async () => !(await t.page.locator('#login-screen').isVisible()), {
    timeout: 15000,
    message: 'login screen hidden',
  });
}

export const journeys = [
  defineJourney({
    id: 'admin-prod-login-shell',
    title: 'Admin login succeeds and the dashboard renders real data',
    priority: 'P0',
    steps: async (t) => {
      await login(t);
      await waitFor(async () => (await t.page.locator('#main-content').innerText()).trim().length > 40, {
        timeout: 30000,
        message: 'dashboard content',
      });
      // Each stat card renders placeholder dots until its own API response settles.
      await waitFor(async () => !(await t.page.locator('.dash-cards').innerText()).includes('...'), {
        timeout: 20000,
        message: 'dashboard stats loaded',
      });
      const dashboard = await t.page.locator('#main-content').innerText();
      t.assert(/概览|dashboard/i.test(dashboard), 'dashboard should render its heading');
      t.note(`dashboard chars=${dashboard.length}`);
      const accountButton = t.page.locator('[data-account-menu], #account-menu-btn, #account-btn').first();
      if (await accountButton.count()) {
        await accountButton.click();
        await t.sleep(300);
        const menu = t.page.locator('#account-menu, .account-menu, [data-account-menu-panel]').first();
        t.assert(await menu.count(), 'account menu should open');
        await t.page.keyboard.press('Escape');
      }
      await t.shot('dashboard');
    },
  }),
  defineJourney({
    id: 'admin-prod-pages',
    title: 'All 13 admin pages + trash render without errors, staying read-only',
    priority: 'P0',
    steps: async (t) => {
      await login(t);
      const rendered = [];
      for (const page of NAV_PAGES) {
        await t.page.evaluate((route) => {
          location.hash = route;
        }, page);
        await waitFor(async () => (await t.page.locator('#main-content').innerText()).trim().length > 20, {
          timeout: 25000,
          message: `${page} content`,
        });
        await t.sleep(250);
        const text = (await t.page.locator('#main-content').innerText()).trim();
        const hash = await t.page.evaluate(() => location.hash);
        t.assert(hash === `#${page}`, `${page}: hash should be #${page}, got ${hash}`);
        t.assert(!/Something went wrong|发生了错误|加载失败/i.test(text), `${page}: renders an error state`);
        rendered.push(`${page}:${text.length}`);
        await t.shot(page);
      }
      t.note(`pages=${rendered.join(', ')}`);
      t.assertEqual(
        t.writeAttempts.length,
        0,
        `read-only guard recorded write attempts: ${t.writeAttempts.join(', ')}`,
      );
      const mistakes = t.diagnostics.pageErrors;
      t.assertEqual(mistakes.length, 0, `page errors: ${mistakes.join(' | ')}`);
    },
  }),
  defineJourney({
    id: 'admin-prod-editor-load',
    title: 'Editor loads typed metadata for the repaired posts (read-only)',
    priority: 'P1',
    steps: async (t) => {
      await login(t);
      await t.page.evaluate(() => {
        location.hash = 'editor&slug=text-only';
      });
      await waitFor(async () => (await t.page.locator('#fm-title').inputValue()).length > 0, {
        timeout: 25000,
        message: 'text-only form populated',
      });
      t.assertEqual(await t.page.locator('#fm-category').inputValue(), '随笔', 'category is typed, not "null"');
      t.assert(
        (await t.page.locator('#fm-tags').inputValue()).includes('极简'),
        'tags load as a list instead of an empty field',
      );
      t.assertEqual(await t.page.locator('#fm-date').inputValue(), '2026-05-01', 'date input keeps the day');
      t.assert((await t.page.locator('#fm-cover').inputValue()).length > 0, 'cover reference loads');
      await t.page.evaluate(() => {
        location.hash = 'editor&slug=fsdfsdgsfgsd';
      });
      await waitFor(async () => (await t.page.locator('#fm-title').inputValue()).length > 0, {
        timeout: 25000,
        message: 'fsdfsdgsfgsd form populated',
      });
      t.assertEqual(await t.page.locator('#fm-category').inputValue(), '', 'null category loads as an empty field');
      t.assertEqual(await t.page.locator('#fm-desc').inputValue(), '', 'null description loads as an empty field');
      t.assertEqual(await t.page.locator('#fm-date').inputValue(), '2026-08-03', 'repaired post date');
      t.assertEqual(t.writeAttempts.length, 0, 'loading the editor must not write');
      await t.shot('editor-text-only');
    },
  }),
  defineJourney({
    id: 'admin-prod-mobile-drawer',
    title: 'Mobile admin: sidebar drawer opens, navigates, and closes',
    priority: 'P1',
    viewport: 'mobile',
    steps: async (t) => {
      await login(t);
      const toggle = t.page.locator('.sidebar-toggle').first();
      t.assert(await toggle.count(), 'mobile sidebar toggle should exist');
      await toggle.click();
      await waitFor(async () => await t.page.locator('#sidebar-nav').isVisible(), {
        timeout: 10000,
        message: 'sidebar visible after toggle',
      });
      await t.page.locator('a.nav-item[data-page="posts"]').click();
      await waitFor(async () => (await t.page.evaluate(() => location.hash)) === '#posts', {
        timeout: 15000,
        message: '#posts route',
      });
      await t.shot('mobile-posts');
      t.assertEqual(t.writeAttempts.length, 0, `write attempts: ${t.writeAttempts.join(', ')}`);
    },
  }),
];
