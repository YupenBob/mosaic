/**
 * Mosaic frontend accessibility scan (axe-core, WCAG 2.2 AA).
 *
 * Scans representative pages in both light and dark color schemes:
 * home, a photo/gallery post, a video post, a music post, a plain post
 * (whichever exist in the current build), the first category and tag
 * pages, and the 404 page.
 *
 * Fails on critical/serious violations; moderate/minor are logged as
 * warnings (post content is user-authored and may carry minor issues).
 *
 * Env:
 *   SITE  base URL (default https://mosaic.xsanye.cn; local: SITE=http://127.0.0.1:3000)
 *
 * Run: node tests/a11y-front.mjs
 * CI:  SITE=http://127.0.0.1:3000 node tests/a11y-front.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = (process.env.SITE || 'https://mosaic.xsanye.cn').replace(/\/+$/, '');
const AXE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'axe-core', 'axe.min.js');
const THEMES = [
  { name: 'light', colorScheme: 'light' },
  { name: 'dark', colorScheme: 'dark' },
];

async function loadJson(route) {
  try {
    const resp = await fetch(`${SITE}${route}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

const posts = (await loadJson('/data/posts.json')) || [];
const categories = (await loadJson('/data/categories.json')) || [];
const tags = (await loadJson('/data/tags.json')) || [];

// Representative route set; skip what the current build doesn't have.
const pages = [{ url: `${SITE}/`, label: 'home', wait: '.post-card, .card-grid > *' }];
const seen = new Set();
function pushPost(post, label) {
  if (!post || seen.has(post.slug)) return;
  seen.add(post.slug);
  pages.push({
    url: `${SITE}/posts/${post.slug}/`,
    label,
    wait: post.photos?.length
      ? '.gallery-item'
      : post.videos?.length
        ? '.video-element'
        : post.music?.length
          ? '.music-track'
          : 'article',
  });
}
pushPost(
  posts.find((p) => (p.photos || []).length > 0),
  'photo',
);
pushPost(
  posts.find((p) => (p.videos || []).length > 0),
  'video',
);
pushPost(
  posts.find((p) => (p.music || []).length > 0),
  'music',
);
pushPost(
  posts.find((p) => !(p.photos || []).length && !(p.videos || []).length && !(p.music || []).length) || posts[0],
  'post',
);
if (categories[0]) {
  pages.push({
    url: `${SITE}/categories/${categories[0].slug}/`,
    label: 'category',
    wait: '.post-card, .card-grid > *',
  });
}
if (tags[0]) {
  pages.push({ url: `${SITE}/tags/${tags[0].slug}/`, label: 'tag', wait: '.post-card, .card-grid > *' });
}
pages.push({ url: `${SITE}/404.html`, label: '404', wait: 'h1' });

const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  for (const theme of THEMES) {
    const context = await browser.newContext({ colorScheme: theme.colorScheme });
    const page = await context.newPage();
    await page.route(
      /(cdn\.jsdelivr\.net|busuanzi\.ibruce\.info|static\.cloudflareinsights\.com|giscus\.app)/,
      (route) => route.abort(),
    );
    for (const p of pages) {
      let res;
      try {
        await page.goto(p.url, { timeout: 60000, waitUntil: 'domcontentloaded' });
        await page
          .locator(p.wait)
          .first()
          .waitFor({ state: 'visible', timeout: 15000 })
          .catch(() => {});
        await page.waitForTimeout(1500);
        await page.addScriptTag({ path: AXE });
        res = await page.evaluate(async () => {
          const x = await window.axe.run(document, { resultTypes: ['violations'] });
          return x.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.length,
            targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
          }));
        });
      } catch (err) {
        console.log(`  [${theme.name}] ${p.label}: ERROR ${String(err.message).split('\n')[0]}`);
        failures++;
        continue;
      }
      const serious = res.filter((v) => v.impact === 'critical' || v.impact === 'serious');
      const moderate = res.filter((v) => v.impact === 'moderate' || v.impact === 'minor');
      console.log(`  [${theme.name}] ${p.label}: ${res.length} violations (${serious.length} serious/critical)`);
      serious.forEach((v) => {
        failures++;
        console.log(`    FAIL [${v.impact}] ${v.id} (${v.nodes} nodes)`);
        v.targets.forEach((t) => console.log(`        ${t.slice(0, 100)}`));
      });
      moderate.forEach((v) => console.log(`    warn [${v.impact}] ${v.id} (${v.nodes} nodes)`));
    }
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(
  `\na11y-front: ${failures === 0 ? 'OK' : failures + ' failure(s)'} (${pages.length} pages x ${THEMES.length} themes)`,
);
process.exit(failures === 0 ? 0 : 1);
