/**
 * Mosaic admin accessibility scan (axe-core, WCAG 2.2 AA).
 *
 * Logs into the real admin, scans all 7 pages in both light and dark
 * themes, and fails on ANY axe violation (the admin UI is fully code-owned).
 *
 * Skips cleanly when worker/.dev.vars has no ADMIN_PASSWORD (CI has no local
 * secrets), same as tests/admin-smoke.mjs.
 *
 * Env:
 *   ADMIN  admin base URL (default https://mosaic-admin.xsanye.cn)
 *
 * Run: node tests/a11y-admin.mjs (wired into `npm run check`)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN = (process.env.ADMIN || 'https://mosaic-admin.xsanye.cn').replace(/\/+$/, '');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AXE = path.join(ROOT, 'node_modules', 'axe-core', 'axe.min.js');
const ROUTES = ['dashboard', 'posts', 'editor', 'build', 'config', 'taxonomy', 'cleanup'];
const THEMES = ['light', 'dark'];

let password = '';
try {
  const dv = fs.readFileSync(path.join(ROOT, 'worker', '.dev.vars'), 'utf8');
  password = (dv.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1]?.trim() || '';
} catch {}

if (!password) {
  console.log('SKIP a11y-admin — ADMIN_PASSWORD not found in worker/.dev.vars (CI has no local secrets)');
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  const page = await browser.newPage();
  await page.route(/(busuanzi\.ibruce\.info|static\.cloudflareinsights\.com|giscus\.app)/, (route) => route.abort());
  await page.goto(ADMIN, { timeout: 90000, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-screen', { timeout: 30000 });
  await page.fill('#login-password', password);
  await page.click('#login-btn');
  await page.waitForSelector('#app:not([style*="display:none"])', { timeout: 30000 });

  // Discover the latest build run id so the detail page can be scanned too.
  let routes = [...ROUTES];
  await page.evaluate(() => (location.hash = 'build'));
  await page.waitForTimeout(6000);
  const runId = await page.evaluate(() => document.querySelector('.build-history-row')?.dataset.runId || '');
  if (runId) {
    routes.push(`build&run=${runId}`);
    console.log(`Build detail route added: build&run=${runId}`);
  }

  for (const theme of THEMES) {
    await page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), theme);
    await page.waitForTimeout(800);
    for (const route of routes) {
      await page.evaluate((h) => (location.hash = h), route);
      await page.waitForTimeout(5000);
      await page.addScriptTag({ path: AXE });
      const res = await page.evaluate(async () => {
        const x = await window.axe.run(document, { resultTypes: ['violations'] });
        return x.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.length,
          targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
        }));
      });
      console.log(`  [${theme}] ${route}: ${res.length} violations`);
      res.forEach((v) => {
        failures++;
        console.log(`    FAIL [${v.impact}] ${v.id} (${v.nodes} nodes)`);
        v.targets.forEach((t) => console.log(`        ${t.slice(0, 100)}`));
      });
    }
  }
} finally {
  await browser.close();
}
console.log(
  `\na11y-admin: ${failures === 0 ? 'OK' : failures + ' violation(s)'} (${ROUTES.length} pages x ${THEMES.length} themes)`,
);
process.exit(failures === 0 ? 0 : 1);
