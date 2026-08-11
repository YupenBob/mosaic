/**
 * Mosaic frontend E2E tests (Playwright test runner).
 *
 * Run: npx playwright test tests/frontend.spec.js
 * Env overrides: SITE, ADMIN, API, MEDIA
 * Local mode: SITE=http://localhost:3000 API=http://localhost:8787 ADMIN=
 */
import { test, expect } from '@playwright/test';

const SITE = (process.env.SITE || 'https://mosaic.xsanye.cn').replace(/\/+$/, '');
const ADMIN =
  process.env.ADMIN !== undefined ? process.env.ADMIN.replace(/\/+$/, '') : 'https://mosaic-admin.xsanye.cn';
const API = (process.env.API || 'https://mosaic-api.xsanye.cn').replace(/\/+$/, '');
const MEDIA = (process.env.MEDIA || 'https://mosaic-media.xsanye.cn').replace(/\/+$/, '');
const SKIP_ADMIN = !ADMIN || ADMIN === 'skip';

test.beforeEach(async ({ page }) => {
  // Abort slow/irrelevant third-party scripts so domcontentloaded isn't blocked by CDNs
  await page.route(/(cdn\.jsdelivr\.net|busuanzi\.ibruce\.info|static\.cloudflareinsights\.com|giscus\.app)/, (route) =>
    route.abort(),
  );
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
    // networkidle never settles on video posts (hls.js keeps fetching);
    // domcontentloaded + a short settle is enough to read the img src attrs.
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    const imgs = page.locator('img[src]');
    const count = await imgs.count();
    let bad = 0;
    for (let i = 0; i < Math.min(count, 10); i++) {
      const src = await imgs.nth(i).getAttribute('src');
      if (!src || src.startsWith('data:')) continue;
      if (src.includes('/media/')) {
        bad++;
        console.log('  LOCAL:', src.slice(0, 100));
      } else if (src.startsWith('http') && !src.startsWith(MEDIA) && !src.startsWith('/api/')) {
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

test('gallery: open post gallery and switch quality', async ({ page }) => {
  const posts = await fetch(`${SITE}/data/posts.json`)
    .then((r) => r.json())
    .catch(() => []);
  const galleryPost = (posts || []).find((p) => (p.photos || []).length > 0);
  test.skip(!galleryPost, 'no gallery post in this build');
  const resp = await page.goto(`${SITE}/posts/${galleryPost.slug}/`, {
    timeout: 60000,
    waitUntil: 'domcontentloaded',
  });
  expect(resp.status()).toBe(200);
  const firstItem = page.locator('.gallery-item img, .gallery-single-item img').first();
  await firstItem.waitFor({ state: 'visible', timeout: 15000 });
  // gallery.js is dynamically imported; its item click listeners are wired
  // before createOverlay() runs, so an attached overlay means init is done.
  await page.locator('#gallery-overlay').waitFor({ state: 'attached', timeout: 15000 });
  await firstItem.click();
  await page.locator('#gallery-current-img').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.gq-pill[data-res="720p"]').click();
  const src = await page.locator('#gallery-current-img').getAttribute('src');
  expect(src).toContain('-720p');
  console.log(`Gallery quality switch: src=${src}`);
});

test('search filters posts (query -> dropdown + grid)', async ({ page }) => {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  // Discover a query that uniquely matches one post across title/description/
  // tags (posts may be renamed/removed; skip when no unique term exists).
  const posts = await fetch(`${SITE}/data/posts.json`)
    .then((r) => r.json())
    .catch(() => []);
  const searchable = (posts || []).map((p) =>
    `${p.title || ''}\n${p.description || ''}\n${(p.tags || []).join('\n')}`.toLowerCase(),
  );
  let query = '';
  let expectedTitle = '';
  for (const p of posts || []) {
    const t = String(p.title || '').trim();
    if (!t) continue;
    if (searchable.filter((s) => s.includes(t.toLowerCase())).length === 1) {
      query = t;
      expectedTitle = p.title;
      break;
    }
  }
  test.skip(!query, 'no uniquely-searchable post in this build');
  const input = page.locator('.search-input');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  // initSearch wires the input listener only after posts.json loads + dynamic
  // imports; wait for the grid to render (initFilter done), then fill — and
  // re-fill if we still raced ahead of the listener.
  await page.locator('.post-card').first().waitFor({ state: 'visible', timeout: 15000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await input.fill(query);
    const items = await page
      .locator('.search-result-item')
      .count()
      .catch(() => 0);
    if (items > 0) break;
    await page.waitForTimeout(1200);
  }
  await page.locator('.search-result-item').first().waitFor({ state: 'visible', timeout: 8000 });
  const results = await page.locator('.search-result-item').count();
  expect(results).toBe(1);
  const gridCards = await page.locator('.post-card').count();
  expect(gridCards).toBe(1);
  const title = (await page.locator('.post-card-title').first().textContent()).trim();
  expect(title).toBe(expectedTitle);
});

test('Worker health endpoint responds', async ({ page }) => {
  const response = await page.goto(`${API}/api/health`);
  expect(response.status()).toBe(200);
  const json = await response.json();
  expect(json.status).toBe('ok');
  console.log('Worker health:', JSON.stringify(json));
});

const MOBILE_VIEWPORTS = [
  { name: 'iPhone 13', width: 390, height: 844 },
  { name: 'Pixel 7', width: 412, height: 915 },
  { name: 'small phone', width: 320, height: 568 },
];

async function assertMobileHls(page) {
  // Let hls.js load for this test (the global beforeEach aborts jsdelivr)
  await page.unrouteAll();
  await page.route(/(busuanzi\.ibruce\.info|static\.cloudflareinsights\.com|giscus\.app)/, (route) => route.abort());
  // Discover a video post from the generated data instead of hardcoding a slug
  // (posts may be renamed/removed; only skip when this build has no video).
  const posts = await fetch(`${SITE}/data/posts.json`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  const videoPost = Array.isArray(posts) ? posts.find((p) => (p.videos || []).length > 0) : undefined;
  test.skip(!videoPost, 'no video post found in this build');
  const postUrl = `${SITE}/posts/${videoPost.slug}/`;
  const resp = await page.goto(postUrl, { timeout: 60000, waitUntil: 'domcontentloaded' });
  expect(resp.status()).toBe(200);
  // hls.js removes <source> children when it falls back to native HLS (e.g. on
  // WebKit), so read the HLS URL from the server-rendered HTML instead.
  await page.waitForSelector('video.video-element[data-hls="true"]', { timeout: 15000 });
  const html = await fetch(postUrl).then((r) => r.text());
  const hlsMatch =
    html.match(/type="application\/x-mpegURL"\s+src="([^"]+\.m3u8[^"]*)"/) ||
    html.match(/src="([^"]+\.m3u8[^"]*)"\s+type="application\/x-mpegURL"/);
  expect(hlsMatch && hlsMatch[1]).toBeTruthy();
  const hlsUrl = hlsMatch[1].startsWith('http') ? hlsMatch[1] : new URL(hlsMatch[1], SITE).href;
  // Direct R2 responses only include ACAO for CORS requests (with Origin)
  const playlistResp = await page.request.get(hlsUrl, { timeout: 20000, headers: { Origin: SITE } });
  expect(playlistResp.status()).toBe(200);
  expect(playlistResp.headers()['access-control-allow-origin']).toBe('*');
  await page.waitForTimeout(3000);
  const hlsLoaded = await page.evaluate(() => typeof window.Hls !== 'undefined');
  expect(hlsLoaded).toBe(true);
  console.log(
    `Mobile HLS: source=${hlsUrl} status=${playlistResp.status()} acao=${playlistResp.headers()['access-control-allow-origin']} hls.js=${hlsLoaded}`,
  );
}

test.describe('mobile HLS matrix', () => {
  // Page + hls.js (415KB) over slow connections can exceed the 30s default
  // test timeout; CI runners are fast, but local/slow links need headroom.
  test.describe.configure({ timeout: 90000 });
  for (const vp of MOBILE_VIEWPORTS) {
    test(`mobile viewport (${vp.name}): video post loads with HLS source`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await assertMobileHls(page);
    });
  }
});

test('admin login page loads', async ({ page }) => {
  test.skip(SKIP_ADMIN, 'ADMIN unset');
  const response = await page.goto(ADMIN);
  expect(response.status()).toBe(200);
  await page.waitForTimeout(3000);
  const loginVisible = await page
    .locator('#login-screen')
    .isVisible()
    .catch(() => false);
  const appVisible = await page
    .locator('#app')
    .isVisible()
    .catch(() => false);
  console.log(`Login visible: ${loginVisible}, App visible: ${appVisible}`);
  expect(loginVisible || appVisible).toBe(true);
});
