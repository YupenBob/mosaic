/**
 * Quick site check via Playwright — verifies media URLs, site loads, admin works.
 *
 * Usage:
 *   node tests/check-site.mjs               # production defaults (xsanye.cn domains)
 *   node tests/check-site.mjs --local       # local dist (port 3000) + wrangler dev (8787)
 *
 * Env overrides: SITE, ADMIN, API, MEDIA
 */
import { chromium } from 'playwright';

const LOCAL = process.argv.includes('--local');
const SITE = (
  LOCAL ? process.env.SITE || 'http://localhost:3000' : process.env.SITE || 'https://mosaic.xsanye.cn'
).replace(/\/+$/, '');
const ADMIN = LOCAL ? null : (process.env.ADMIN || 'https://mosaic-admin.xsanye.cn').replace(/\/+$/, '');
const API = (
  LOCAL ? process.env.API || 'http://localhost:8787' : process.env.API || 'https://mosaic-api.xsanye.cn'
).replace(/\/+$/, '');
const MEDIA = (process.env.MEDIA || 'https://mosaic-media.xsanye.cn').replace(/\/+$/, '');
const abs = (href) => (href.startsWith('http') ? href : new URL(href, SITE + '/').href);

async function main() {
  const browser = await chromium.launch({ headless: true });
  let passed = 0,
    failed = 0;
  const context = await browser.newContext();
  // Abort slow/irrelevant third-party scripts so domcontentloaded isn't blocked by CDNs
  await context.route(
    /(cdn\.jsdelivr\.net|busuanzi\.ibruce\.info|static\.cloudflareinsights\.com|giscus\.app)/,
    (route) => route.abort(),
  );
  const check = (name, ok, detail = '') => {
    if (ok) {
      passed++;
      console.log(`  PASS ${name}${detail ? ': ' + detail : ''}`);
    } else {
      failed++;
      console.log(`  FAIL ${name}${detail ? ': ' + detail : ''}`);
    }
  };

  try {
    // ── 1. Worker Health ──
    console.log('\nWorker Health');
    try {
      const resp = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(15000) });
      const health = await resp.json();
      check('Health endpoint', resp.ok && health?.status === 'ok', `${resp.status} ${JSON.stringify(health)}`);
    } catch (e) {
      check('Health endpoint', false, e.message);
    }

    // 1b. Dependency probes (real upstream checks — GitHub/R2 reachability)
    for (const [name, probePath] of [
      ['GitHub', '/api/health/github'],
      ['R2', '/api/health/r2'],
    ]) {
      try {
        const resp = await fetch(`${API}${probePath}`, { signal: AbortSignal.timeout(15000) });
        const body = await resp.json();
        check(
          `${name} health probe`,
          resp.ok && body?.status === 'ok' && Number.isFinite(body?.latency),
          `${resp.status} ${JSON.stringify(body)}`,
        );
      } catch (e) {
        check(`${name} health probe`, false, e.message);
      }
    }

    // ── 2. Site loads ──
    console.log('\nHomepage');
    const page = await context.newPage();
    const resp = await page.goto(SITE, { timeout: 30000, waitUntil: 'domcontentloaded' });
    check('Homepage loads', !!resp && resp.status() === 200, `status=${resp?.status()}`);
    const title = await page.title();
    check('Homepage title', title.length > 0, title);
    const postLinks = await page.locator('a[href*="posts/"]').count();
    check('Post links found', postLinks > 0, `${postLinks} links`);

    // ── 3. Category page assets (relative path regression) ──
    console.log('\nCategory page');
    try {
      const catLink = page.locator('a[href*="categories/"]').first();
      if (await catLink.count()) {
        const href = await catLink.getAttribute('href');
        await page.goto(abs(href), { timeout: 30000, waitUntil: 'domcontentloaded' });
        const cssHref = await page
          .locator('link[rel="stylesheet"][href*="assets/"]')
          .first()
          .getAttribute('href')
          .catch(() => null);
        const cssUrl = cssHref && !cssHref.startsWith('http') ? new URL(cssHref, page.url()).href : cssHref;
        if (cssUrl) {
          const cssResp = await fetch(cssUrl, { signal: AbortSignal.timeout(15000) });
          check('Category page stylesheet loads', cssResp.ok, `${cssUrl} -> ${cssResp.status}`);
        } else {
          check('Category page stylesheet loads', false, 'no stylesheet found');
        }
        await page.goto(SITE, { timeout: 30000, waitUntil: 'domcontentloaded' });
      } else {
        console.log('  (no category links on homepage, skipping)');
      }
    } catch (e) {
      check('Category page stylesheet loads', false, e.message);
    }

    // ── 4. Media URLs in posts ──
    console.log('\nMedia URLs');
    try {
      if (postLinks > 0) {
        const firstLink = await page.locator('a[href*="posts/"]').first().getAttribute('href');
        await page.goto(abs(firstLink), { timeout: 30000, waitUntil: 'domcontentloaded' });
        const imgs = page.locator('img[src]');
        const imgCount = await imgs.count();
        let bad = 0;
        const badUrls = [];
        let mediaBaseUrls = 0;
        for (let i = 0; i < imgCount; i++) {
          const src = await imgs.nth(i).getAttribute('src');
          if (!src || src.startsWith('data:')) continue;
          if (src.includes('/media/')) {
            bad++;
            badUrls.push(src.slice(0, 100));
          } else if (src.startsWith(MEDIA) || src.startsWith('http')) mediaBaseUrls++;
        }
        check('No local media/ paths', bad === 0, bad > 0 ? badUrls.join(', ') : `${imgCount} images`);
        if (!LOCAL) {
          check('Media served from R2/media domain', mediaBaseUrls > 0, `${mediaBaseUrls}/${imgCount} absolute URLs`);
        }
      } else {
        console.log('  (no posts, skipping media check)');
      }
    } catch (e) {
      check('Media URLs check', false, e.message);
    }
    await page.close();

    // ── 4b. Feed + Sitemap ──
    console.log('\nFeed & Sitemap');
    for (const f of ['feed.xml', 'sitemap.xml']) {
      try {
        const resp = await fetch(`${SITE}/${f}`, { signal: AbortSignal.timeout(15000) });
        check(`${f} loads`, resp.ok, `${resp.status}`);
      } catch (e) {
        check(`${f} loads`, false, e.message);
      }
    }

    // ── 5. Admin loads ──
    if (ADMIN) {
      console.log('\nAdmin Panel');
      try {
        const adminPage = await browser.newPage();
        const adminResp = await adminPage.goto(ADMIN, { timeout: 30000, waitUntil: 'domcontentloaded' });
        await adminPage.waitForTimeout(3000);
        const loginVisible = await adminPage
          .locator('#login-screen')
          .isVisible()
          .catch(() => false);
        const appVisible = await adminPage
          .locator('#app')
          .isVisible()
          .catch(() => false);
        check(
          'Admin loads',
          !!adminResp && (loginVisible || appVisible),
          loginVisible ? 'login screen' : appVisible ? 'app loaded' : 'unknown state',
        );
        await adminPage.close();
      } catch (e) {
        check('Admin loads', false, e.message);
      }
    }
  } finally {
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    await browser.close();
    if (failed > 0) process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
