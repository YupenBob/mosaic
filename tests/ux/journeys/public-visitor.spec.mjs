import { defineJourney, waitFor } from '../lib/journey.mjs';
import { mockPublicApi } from '../lib/browser.mjs';

export const area = 'public';
const journey = (id, title, steps) => defineJourney({ id: `visitor-${id}`, title, priority: 'P1', timeoutMs: 30000, steps: async t => { await mockPublicApi(t.page); await steps(t); } });
const cards = p => p.locator('a.post-card');
const index = p => p.evaluate(() => fetch('/data/posts-index.json').then(r => r.json()));
const slugs = p => cards(p).evaluateAll(els => els.map(e => e.dataset.slug).sort());
const equalList = (t, actual, expected, message) => t.assertEqual(JSON.stringify(actual.sort()), JSON.stringify(expected.sort()), message);
const ready = async t => { await t.goto('/'); await t.page.locator('.search-input[data-search-ready="true"]').waitFor(); };
const noOverflow = async t => t.assert(await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page should not overflow horizontally');
export const journeys = [
  journey('masonry', 'Home masonry cards and image upgrade at desktop and mobile widths', async t => {
    const html = await (await t.page.request.get(t.base + '/')).text();
    t.assert(/class="post-card-img[^\"]*"[^>]*data-src=/.test(html), 'server provides LQIP with deferred HD image');
    await ready(t); t.assertEqual(await cards(t.page).count(), 14, '14 post card links');
    for (const href of await cards(t.page).evaluateAll(es => es.map(e => e.getAttribute('href')))) t.assert(/^posts\/[^/]+\/$/.test(href), `post href ${href}`);
    await noOverflow(t);
    t.assert((await t.page.locator('.post-card-img').count()) > 0, 'cards contain images');
    await waitFor(async () => (await t.page.locator('.post-card-img[data-upgraded=true]').count()) > 0, { timeout: 12000, message: 'HD image upgrade' });
    await t.page.setViewportSize({ width: 390, height: 844 }); await waitFor(async () => t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), { message: 'mobile layout has no horizontal overflow' });
  }),
  journey('card-back', 'Open a card, visit its post and return with scroll preserved', async t => {
    await ready(t); const card = cards(t.page).nth(8); await card.scrollIntoViewIfNeeded(); await card.focus();
    const before = await t.page.evaluate(() => scrollY); await card.click();
    await t.page.locator('dialog.note-modal[open] .note-open-post').waitFor(); await t.page.locator('.note-open-post').click();
    await t.page.waitForURL('**/posts/**/'); t.assert((await t.page.locator('h1').first().innerText()).trim().length > 0, 'post heading');
    await t.page.goBack(); await waitFor(async () => Math.abs((await t.page.evaluate(() => scrollY)) - before) < 80, { message: 'restored scroll' });
  }),
  journey('categories', 'Category navigation matches the posts index', async t => {
    await ready(t); const posts = await index(t.page); const link = t.page.locator('a[href^="categories/"]').first();
    t.assert(await link.count() > 0, 'home exposes category links'); const href = await link.getAttribute('href'); await link.click();
    await t.page.waitForURL('**/categories/**'); const category = await t.page.locator('body').getAttribute('data-category');
    await waitFor(async () => (await cards(t.page).count()) === posts.filter(p => p.category === category).length, { message: 'category cards' });
    equalList(t, await slugs(t.page), posts.filter(p => p.category === category).map(p => p.slug), `category ${href}`);
  }),
  journey('tag', 'Tag filter selects and clears matching posts', async t => {
    await ready(t); const posts = await index(t.page); const pill = t.page.locator('.filter-pill[data-tag]').first();
    t.assert(await pill.count() > 0, 'tag filter is exposed'); const tag = await pill.getAttribute('data-tag'); await pill.click();
    await waitFor(async () => (await pill.getAttribute('aria-pressed')) === 'true', { message: 'tag selected' });
    const expected = posts.filter(p => p.tags.includes(tag)).map(p => p.slug);
    await waitFor(async () => JSON.stringify(await slugs(t.page)) === JSON.stringify([...expected].sort()), { message: 'tag cards rendered' });
    equalList(t, await slugs(t.page), expected, 'tag matches index');
    await pill.click(); await waitFor(async () => (await cards(t.page).count()) === 14, { message: 'tag cleared' });
  }),
  journey('search', 'Search threshold, results, empty state, Escape and keyboard selection', async t => {
    await ready(t); const input = t.page.locator('.search-input'); const posts = await index(t.page);
    t.assertEqual(await t.page.evaluate(() => window.__MOSAIC_CONFIG.searchMinChars), 2, 'searchMinChars');
    await input.fill('m');
    // Let the configured 250ms search debounce elapse before testing the threshold.
    await t.page.waitForTimeout(350); t.assertEqual(await input.getAttribute('aria-expanded'), 'false', 'one character does not open dropdown');
    const query = posts[0].title.slice(0, 2); await input.fill(query);
    await waitFor(async () => (await input.getAttribute('aria-expanded')) === 'true' && (await t.page.locator('[role=option]').count()) > 0, { message: 'search results' });
    await waitFor(async () => (await cards(t.page).count()) < 14, { message: 'search grid filtered' }); await input.press('Escape'); t.assertEqual(await input.getAttribute('aria-expanded'), 'false', 'Escape closes results');
    await input.fill('zzzzzzzz-no-result'); await t.page.locator('.search-result-empty').waitFor(); await t.page.locator('.empty-state').waitFor({ state: 'visible' });
    await input.fill(query); await t.page.locator('[role=option]').first().waitFor(); await input.press('ArrowDown');
    await input.press('ArrowUp'); await input.press('ArrowDown');
    const active = await input.getAttribute('aria-activedescendant'); t.assert(!!active, 'arrow selects result'); const href = await t.page.locator(`#${active}`).getAttribute('href');
    await input.press('Enter'); await t.page.waitForURL(url => url.pathname.endsWith('/' + href));
  }),
  journey('theme', 'Theme and accent persist and bootstrap before CSS', async t => {
    const html = await (await t.page.request.get(t.base + '/')).text(); t.assert(html.indexOf("setAttribute('data-theme'") < html.indexOf('rel="stylesheet"'), 'theme bootstrap precedes CSS');
    await ready(t); await t.page.locator('#theme-menu-toggle').click(); await t.page.locator('label.theme-mode:has(input[value="light"])').click();
    await t.page.locator('label.theme-mode:has(input[value="dark"])').click(); await t.page.locator('[data-accent-option="violet"]').click();
    await t.page.reload({ waitUntil: 'domcontentloaded' }); const state = await t.page.evaluate(() => ({ theme: document.documentElement.dataset.theme, mode: document.documentElement.dataset.themeMode, accent: document.documentElement.dataset.accent, storedTheme: localStorage.getItem('mosaic_theme'), storedAccent: localStorage.getItem('mosaic_accent') }));
    t.assertEqual(JSON.stringify(state), JSON.stringify({ theme: 'dark', mode: 'dark', accent: 'violet', storedTheme: 'dark', storedAccent: 'violet' }), 'persisted appearance');
  }),
  journey('note', 'Note modal opens, restores focus, deep links and follows history', async t => {
    await ready(t); const card = cards(t.page).nth(1); const slug = await card.getAttribute('data-slug'); await card.focus(); await card.click();
    const dialog = t.page.locator('dialog.note-modal[open]'); await dialog.locator('.note-open-post').waitFor(); t.assert(new URL(t.page.url()).searchParams.get('note') === slug, 'note URL');
    await t.page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); await waitFor(async () => await card.evaluate(el => document.activeElement === el), { message: 'focus restored' });
    await t.goto('/?note=' + encodeURIComponent(slug)); await dialog.locator('.note-open-post').waitFor(); await t.page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await card.click(); await dialog.locator('.note-open-post').waitFor(); await t.page.goBack(); await dialog.waitFor({ state: 'hidden' });
    await card.click(); await dialog.locator('.note-open-post').waitFor(); await t.page.mouse.click(5, 5); await dialog.waitFor({ state: 'hidden' });
  }),
  journey('likes', 'Post like and unlike persist and send mocked tracking calls', async t => {
    // Replace the default route with an instrumented instance before navigation.
    await t.page.unroute('**/api/**'); const api = await mockPublicApi(t.page); await t.goto('/posts/text-only/');
    const button = t.page.locator('.like-button'); await button.waitFor(); await waitFor(async () => api.tracks.some(x => x.includes('/track/view/')), { message: 'view tracked' });
    await button.click(); await waitFor(async () => api.likes === 1 && /1/.test(await button.innerText()), { message: 'like count' });
    await t.page.reload(); await waitFor(async () => button.evaluate(el => el.classList.contains('liked')), { message: 'liked after reload' });
    await button.click(); await waitFor(async () => api.likes === 0 && !await button.evaluate(el => el.classList.contains('liked')), { message: 'unliked' });
    t.assertEqual(api.tracks.filter(x => x.includes('/track/like/')).length, 2, 'like and unlike requests');
  }),
  journey('routes', 'RSS, robots, sitemap and missing-page response', async t => {
    for (const route of ['/feed.xml', '/robots.txt', '/sitemap.xml', '/404.html']) { const response = await t.page.request.get(t.base + route); t.assertEqual(response.status(), 200, `${route} status`); t.assert((await response.text()).length > 50, `${route} content`); }
    const missing = await t.page.request.get(t.base + '/no-such-visitor-page/'); t.assertEqual(missing.status(), 404, 'missing page status');
  }),
];
