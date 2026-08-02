/**
 * Mosaic frontend E2E tests (Playwright test runner).
 *
 * Run: npx playwright test tests/frontend.spec.js
 * Env overrides: SITE, ADMIN, API, MEDIA
 * Local mode: SITE=http://localhost:3000 API=http://localhost:8787 ADMIN=
 */
import { test, expect } from '@playwright/test';

const SITE = (process.env.SITE || 'https://mosaic.xsanye.cn').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN !== undefined ? process.env.ADMIN.replace(/\/+$/, '') : 'https://mosaic-admin.xsanye.cn';
const API = (process.env.API || 'https://mosaic-api.xsanye.cn').replace(/\/+$/, '');
const MEDIA = (process.env.MEDIA || 'https://mosaic-media.xsanye.cn').replace(/\/+$/, '');
const SKIP_ADMIN = !ADMIN || ADMIN === 'skip';

test.beforeEach(async ({ page }) => {
  // Abort slow/irrelevant third-party scripts so domcontentloaded isn't blocked by CDNs
  await page.route(/(cdn\.jsdelivr\.net|busuanzi\.ibruce\.info|static\.cloudflareinsights\.com|giscus\.app)/, (route) => route.abort());
});

test('homepage loads and shows posts', async ({ page }) => {
  const response = await page.goto(SITE);
  expect(response.status()).toBe(200);
  await expect(page.locator('h1, .post-card, .card-grid > *').first()).toBeVisible({ timeout: 10000 });
  console.log('Title:', await page.title());
});

test('images use R2 media domain, not local media/ paths', async ({ page }) => {
  await page.goto(SITE);
  const firstPostLink = page.locator('a[href*="posts/"]').first();
  if (await firstPostLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await firstPostLink.click();
    await page.waitForLoadState('networkidle');
    const imgs = page.locator('img[src]');
    const count = await imgs.count();
    let bad = 0;
    for (let i = 0; i < Math.min(count, 10); i++) {
      const src = await imgs.nth(i).getAttribute('src');
      if (!src || src.startsWith('data:')) continue;
      if (src.includes('/media/')) { bad++; console.log('  LOCAL:', src.slice(0, 100)); }
      else if (src.startsWith('http') && !src.startsWith(MEDIA) && !src.startsWith('/api/')) {
        console.log('  EXTERNAL:', src.slice(0, 100));
      }
    }
    console.log(`Images checked: ${count}, local media paths: ${bad}`);
    expect(bad).toBe(0);
  } else {
    console.log('No post links found on homepage — skipping image check');
  }
});

test('category page stylesheet loads (relative path regression)', async ({ page }) => {
  await page.goto(SITE);
  const catLink = page.locator('a[href*="categories/"]').first();
  if (await catLink.count()) {
    await catLink.click();
    await page.waitForLoadState('domcontentloaded');
    const cssHref = await page.locator('link[rel="stylesheet"][href*="assets/"]').first().getAttribute('href');
    const cssUrl = cssHref && !cssHref.startsWith('http') ? new URL(cssHref, page.url()).href : cssHref;
    const cssResp = await page.request.get(cssUrl);
    expect(cssResp.status()).toBe(200);
    console.log(`Category stylesheet: ${cssUrl} -> ${cssResp.status()}`);
  } else {
    console.log('No category links — skipping');
  }
});

test('Worker health endpoint responds', async ({ page }) => {
  const response = await page.goto(`${API}/api/health`);
  expect(response.status()).toBe(200);
  const json = await response.json();
  expect(json.status).toBe('ok');
  console.log('Worker health:', JSON.stringify(json));
});

test('admin login page loads', async ({ page }) => {
  test.skip(SKIP_ADMIN, 'ADMIN unset');
  const response = await page.goto(ADMIN);
  expect(response.status()).toBe(200);
  await page.waitForTimeout(3000);
  const loginVisible = await page.locator('#login-screen').isVisible().catch(() => false);
  const appVisible = await page.locator('#app').isVisible().catch(() => false);
  console.log(`Login visible: ${loginVisible}, App visible: ${appVisible}`);
  expect(loginVisible || appVisible).toBe(true);
});
