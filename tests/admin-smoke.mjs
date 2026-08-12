/**
 * Admin panel end-to-end smoke: real login + dashboard load.
 * Requires ADMIN_URL env (default production) and the admin password from
 * worker/.dev.vars (ADMIN_PASSWORD). Never prints the password.
 *
 * Usage: node tests/admin-smoke.mjs (or npm run test:admin)
 * Wired into `npm run check`: skips cleanly when worker/.dev.vars has no
 * ADMIN_PASSWORD (CI has no local secrets), so local checks get a real login
 * while CI stays green without credentials.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const ADMIN_URL = (process.env.ADMIN_URL || 'https://mosaic-admin.xsanye.cn').replace(/\/+$/, '');
let password = '';
try {
  const devVars = fs.readFileSync(new URL('../worker/.dev.vars', import.meta.url), 'utf8');
  password = (devVars.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1]?.trim() || '';
} catch {}

if (!password) {
  console.log('SKIP admin-smoke — ADMIN_PASSWORD not found in worker/.dev.vars (CI has no local secrets)');
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  // Chart.js/marked/purify are self-hosted in js/vendor; abort only slow or
  // slow/non-essential third parties.
  await page.route(/(busuanzi\.ibruce\.info|static\.cloudflareinsights\.com|giscus\.app)/, (route) => route.abort());
  // Slow links (e.g. long-tail JS/CSS delivery) can delay DOMContentLoaded;
  // CI runners are fast, but local machines need headroom.
  await page.goto(ADMIN_URL, { timeout: 60000, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-screen', { timeout: 15000 });
  await page.fill('#login-password', password);
  await page.click('#login-btn');
  // App should show after successful login
  await page.waitForSelector('#app:not([style*="display:none"])', { timeout: 20000 });
  await page.waitForTimeout(6000); // allow dashboard data to load
  const title = await page.title();
  const navItems = await page.locator('.sidebar-nav .nav-item').count();
  const heading = await page
    .locator('#main-content h1')
    .first()
    .textContent()
    .catch(() => '');
  console.log(`Admin login OK — title=${title}, navItems=${navItems}, heading=${heading.trim()}`);

  // Navigate to posts page and confirm the list renders
  await page.evaluate(() => {
    location.hash = 'posts';
  });
  await page.waitForTimeout(5000);
  const postRows = await page
    .locator('#main-content .post-row, #main-content table tbody tr, #main-content [class*="post-"]')
    .count();
  const hasTable = await page.locator('#main-content table, #main-content .post-list').count();
  console.log(`Posts page loaded — table/list present=${hasTable > 0}, rows-or-cards=${postRows}`);

  // Navigate to the build page (merged single view) and confirm it renders
  await page.evaluate(() => {
    location.hash = 'build';
  });
  await page.waitForTimeout(6000);
  const summaryCards = await page.locator('.build-summary .dash-big-card').count();
  const statusCard = await page.locator('#build-status-card .build-status-card').count();
  const historyRows = await page.locator('.build-history-row').count();
  const githubLink = await page.locator('#build-history a[href*="actions/workflows"]').count();
  console.log(
    `Build page loaded — summary=${summaryCards}, statusCard=${statusCard}, history=${historyRows}, githubLink=${githubLink}`,
  );
  if (summaryCards < 1 || statusCard < 1 || historyRows < 1 || githubLink < 1) {
    console.error('Build page smoke failed: expected summary + status card + history + GitHub link');
    process.exitCode = 1;
  }

  // Build detail page: clicking a history row opens the run detail with a step
  // timeline; back returns to the list.
  if (historyRows > 0) {
    await page.locator('.build-history-main').first().click();
    await page.waitForSelector('#build-detail-root', { timeout: 15000 });
    await page.waitForTimeout(1500);
    const detailTitle = (
      await page
        .locator('.page-header h1')
        .textContent()
        .catch(() => '')
    ).trim();
    const stepRows = await page.locator('#build-detail-root .build-step-row').count();
    const backBtn = await page.locator('.page-header-actions button[onclick*="hash=\'build\'"]').count();
    console.log(`Build detail page — title=${detailTitle.slice(0, 40)}, steps=${stepRows}, backBtn=${backBtn}`);
    if (stepRows < 1 || backBtn < 1) {
      console.error('Build detail smoke failed: expected step timeline + back button');
      process.exitCode = 1;
    }
    await page.evaluate(() => {
      location.hash = 'build';
    });
    await page.waitForTimeout(5000);
    const backRows = await page.locator('.build-history-row').count();
    if (backRows < 1) {
      console.error('Build detail smoke failed: back did not restore the history list');
      process.exitCode = 1;
    }
  }

  // Editor page: new-post form renders with its core fields (render-only, so
  // we don't trip draft autosave or the leave-interception guard).
  await page.evaluate(() => {
    location.hash = 'editor';
  });
  await page.waitForTimeout(4000);
  const slugVisible = await page
    .locator('#fm-slug')
    .isVisible()
    .catch(() => false);
  const titleVisible = await page
    .locator('#fm-title')
    .isVisible()
    .catch(() => false);
  const bodyVisible = await page
    .locator('#fm-blocks')
    .isVisible()
    .catch(() => false);
  const bodyTextarea = await page.locator('#fm-body').count();
  const mediaInput = await page.locator('#editor-media-input').count();
  console.log(
    `Editor page loaded — slug=${slugVisible}, title=${titleVisible}, body=${bodyVisible}, bodyTextarea=${bodyTextarea}, mediaInput=${mediaInput}`,
  );
  if (!slugVisible || !titleVisible || !bodyVisible || bodyTextarea < 1 || mediaInput < 1) {
    console.error('Editor smoke failed: expected slug/title fields + block editor + media input');
    process.exitCode = 1;
  }

  // Editor page (media post): media panel cells are draggable and carry
  // insert buttons/insert-all (placeholder composition UX).
  let mediaSlug = '';
  try {
    const front = await fetch('https://mosaic.xsanye.cn/data/posts.json').then((r) => r.json());
    mediaSlug = (front || []).find(
      (p) => (p.photos || []).length || (p.videos || []).length || (p.music || []).length,
    )?.slug;
  } catch {}
  if (mediaSlug) {
    await page.evaluate((s) => {
      location.hash = 'editor&slug=' + s;
    }, mediaSlug);
    await page.waitForTimeout(5000);
    const draggableCells = await page.locator('#existing-media .media-cell[draggable]').count();
    const insertBtns = await page.locator('#existing-media .media-cell-insert').count();
    const insertAllBtns = await page.locator('#existing-media .media-group-head .btn').count();
    console.log(
      `Editor media panel (${mediaSlug}) — draggable=${draggableCells}, insertBtns=${insertBtns}, insertAll=${insertAllBtns}`,
    );
    if (draggableCells < 1 || insertBtns < 1 || insertAllBtns < 1) {
      console.error('Editor smoke failed: expected draggable media cells + insert buttons');
      process.exitCode = 1;
    }
  }

  // Config page: section cards render
  await page.evaluate(() => {
    location.hash = 'config';
  });
  await page.waitForTimeout(4000);
  const configSections = await page.locator('.config-section').count();
  console.log(`Config page loaded — sections=${configSections}`);
  if (configSections < 1) {
    console.error('Config smoke failed: expected config section cards');
    process.exitCode = 1;
  }

  // Taxonomy page: category/tag lists render
  await page.evaluate(() => {
    location.hash = 'taxonomy';
  });
  await page.waitForTimeout(4000);
  const taxHeading = await page
    .locator('#main-content h1')
    .first()
    .textContent()
    .catch(() => '');
  const badges = await page.locator('.badge').count();
  console.log(`Taxonomy page loaded — heading=${taxHeading.trim() || '(empty)'}, badges=${badges}`);
  if (!taxHeading.trim() || badges < 1) {
    console.error('Taxonomy smoke failed: expected heading + category/tag count badges');
    process.exitCode = 1;
  }

  // Cleanup page: orphan stats + scan UI render
  await page.evaluate(() => {
    location.hash = 'cleanup';
  });
  await page.waitForTimeout(4000);
  const cleanupStatCards = await page.locator('.cleanup-stat-row .dash-big-card').count();
  console.log(`Cleanup page loaded — statCards=${cleanupStatCards}`);
  if (cleanupStatCards < 2) {
    console.error('Cleanup smoke failed: expected orphan stats cards');
    process.exitCode = 1;
  }
  await page.close();
} finally {
  await browser.close();
}
