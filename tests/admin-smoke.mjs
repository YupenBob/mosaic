/**
 * Admin panel end-to-end smoke: real login + dashboard load.
 * Requires ADMIN_URL env (default production) and the admin password from
 * worker/.dev.vars (ADMIN_PASSWORD). Never prints the password.
 *
 * Usage: node tests/admin-smoke.mjs
 */
import { chromium } from 'playwright';
import fs from 'fs';

const ADMIN_URL = (process.env.ADMIN_URL || 'https://mosaic-admin.xsanye.cn').replace(/\/+$/, '');
const devVars = fs.readFileSync(new URL('../worker/.dev.vars', import.meta.url), 'utf8');
const password = (devVars.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1]?.trim() || '';

if (!password) { console.error('ADMIN_PASSWORD not found in worker/.dev.vars'); process.exit(1); }

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  // Keep Chart.js (jsdelivr) reachable — the dashboard needs it; abort only
  // slow/non-essential third parties.
  await page.route(/(busuanzi\.ibruce\.info|static\.cloudflareinsights\.com|giscus\.app)/, (route) => route.abort());
  await page.goto(ADMIN_URL, { timeout: 30000, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-screen', { timeout: 15000 });
  await page.fill('#login-password', password);
  await page.click('#login-btn');
  // App should show after successful login
  await page.waitForSelector('#app:not([style*="display:none"])', { timeout: 20000 });
  await page.waitForTimeout(6000); // allow dashboard data to load
  const title = await page.title();
  const navItems = await page.locator('.sidebar-nav .nav-item').count();
  const heading = await page.locator('#main-content h1').first().textContent().catch(() => '');
  console.log(`Admin login OK — title=${title}, navItems=${navItems}, heading=${heading.trim()}`);

  // Navigate to posts page and confirm the list renders
  await page.evaluate(() => { location.hash = 'posts'; });
  await page.waitForTimeout(5000);
  const postRows = await page.locator('#main-content .post-row, #main-content table tbody tr, #main-content [class*="post-"]').count();
  const hasTable = await page.locator('#main-content table, #main-content .post-list').count();
  console.log(`Posts page loaded — table/list present=${hasTable > 0}, rows-or-cards=${postRows}`);
  await page.close();
} finally {
  await browser.close();
}
