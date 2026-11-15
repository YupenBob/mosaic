import { defineJourney, waitFor } from '../lib/journey.mjs';
export const area = 'search';
export const targets = ['fixtures'];
const j = (id, title, steps) => defineJourney({ id, title, priority: 'P1', steps });
const input = (t) => t.page.locator('.search-input');
const expanded = (t) => input(t).getAttribute('aria-expanded');
const cards = (t) => t.page.locator('a.post-card').evaluateAll((es) => JSON.stringify(es.map((e) => e.href)));
const ready = (t) => t.page.waitForFunction(() => document.documentElement.dataset.interactive === 'ready');
// Active search/category/tag filters intentionally use the site-wide index.
// Clearing all state must restore the exact SSR browsing slice and order.
export const journeys = [
  j('G-search-ime', 'IME composition and commit', async (t) => {
    await t.goto('/');
    await ready(t);
    await input(t).focus();
    const c = await t.context.newCDPSession(t.page);
    await c.send('Input.imeSetComposition', { text: 'bizhi', selectionStart: 5, selectionEnd: 5 });
    await t.sleep(400);
    t.assertEqual(await expanded(t), 'false', 'composition does not open');
    t.assertEqual(await t.page.locator('a.post-card').count(), 20, 'composition does not filter');
    await c.send('Input.insertText', { text: '壁纸' });
    await waitFor(async () => (await expanded(t)) === 'true', { message: 'committed query opens' });
    t.assert(await t.page.locator('.search-result-item[href*="wallpaper-deep"]').count(), 'wallpaper result');
    await waitFor(async () => (await t.page.locator('a.post-card[href*="wallpaper-deep"]').count()) === 1, {
      message: 'committed query filters grid to wallpaper post',
    });
  }),
  j('G-search-keyboard', 'Search length, keyboard, highlight, and clear', async (t) => {
    await t.goto('/');
    await ready(t);
    const initial = await cards(t);
    await input(t).fill('分');
    await t.sleep(400);
    t.assertEqual(await expanded(t), 'false', 'one character closed');
    await input(t).fill('分页');
    await waitFor(async () => (await expanded(t)) === 'true', { message: 'two character dropdown' });
    await waitFor(async () => (await t.page.locator('a.post-card').count()) === 55, {
      message: 'intentional site-wide search includes off-page matches',
    });
    t.assert(await t.page.locator('.search-result-item mark').count(), 'highlight');
    await input(t).press('ArrowDown');
    const a = await input(t).getAttribute('aria-activedescendant');
    t.assert(a, 'down active');
    await input(t).press('ArrowDown');
    const b = await input(t).getAttribute('aria-activedescendant');
    t.assert(a !== b, 'down moves');
    await input(t).press('ArrowUp');
    t.assertEqual(await input(t).getAttribute('aria-activedescendant'), a, 'up moves');
    await input(t).press('Escape');
    t.assertEqual(await expanded(t), 'false', 'escape closes');
    await input(t).press('Escape');
    t.assertEqual(await input(t).inputValue(), '', 'second escape clears');
    await waitFor(async () => (await cards(t)) === initial, { message: 'exact first-page grid restored' });
    t.assertEqual(await t.page.locator('a.post-card').count(), 20, 'grid restored');
    await input(t).fill('分页');
    await waitFor(async () => (await expanded(t)) === 'true', { message: 'results ready for navigation' });
    await input(t).press('ArrowDown');
    const href = await t.page
      .locator('#' + (await input(t).getAttribute('aria-activedescendant')))
      .getAttribute('href');
    await input(t).press('Enter');
    await waitFor(() => t.page.url().includes(href), { message: 'enter navigates' });
  }),
  j('G-search-filter-clear', 'Clearing combined filters restores the current browsing page', async (t) => {
    await t.goto('/page/2/');
    await ready(t);
    const initial = await cards(t);
    await input(t).fill('分页');
    await waitFor(async () => (await t.page.locator('a.post-card').count()) === 55, { message: 'site-wide query' });
    await input(t).press('Escape'); // Dismiss suggestions before using the pills beneath them.
    const category = t.page.locator('.filter-pill[data-category="分页"]');
    const tag = t.page.locator('.filter-pill[data-tag="分页"]');
    await category.click();
    await waitFor(async () => (await t.page.locator('a.post-card').count()) === 28, { message: 'query and category' });
    await input(t).fill('');
    await waitFor(async () => (await t.page.locator('a.post-card').count()) === 28, {
      message: 'category remains after query clear',
    });
    await tag.click();
    await category.click();
    await waitFor(async () => (await t.page.locator('a.post-card').count()) === 55, {
      message: 'tag remains after category clear',
    });
    await tag.click();
    await waitFor(async () => (await cards(t)) === initial, {
      message: 'exact page-two slice restored after all filters clear',
    });
  }),
  j('G-search-special', 'Special queries, case and shortcut', async (t) => {
    await t.goto('/');
    await ready(t);
    await t.page.locator('body').click({ position: { x: 5, y: 5 } });
    await t.page.keyboard.press('/');
    t.assert(await input(t).evaluate((e) => document.activeElement === e), 'slash focuses');
    let uppercaseResults;
    for (const q of ['nonsensezzzz', '<img src=x onerror=window.__searchxss=1>', 'x'.repeat(300), 'HLS', 'hls']) {
      await input(t).fill(q);
      await waitFor(async () => (await expanded(t)) === 'true', { message: 'query renders' });
      await t.sleep(350);
      t.assertEqual(await t.page.evaluate(() => window.__searchxss || 0), 0, 'no injection');
      if (q === 'nonsensezzzz') t.assert(await t.page.locator('.search-result-empty').isVisible(), 'empty message');
      if (q === 'HLS') uppercaseResults = await t.page.locator('.search-result-item').allTextContents();
      if (q === 'hls')
        t.assertEqual(
          JSON.stringify(await t.page.locator('.search-result-item').allTextContents()),
          JSON.stringify(uppercaseResults),
          'case-insensitive results match',
        );
    }
    await t.page.evaluate(() => {
      const x = document.createElement('input');
      x.id = 'other-input';
      document.body.append(x);
      x.focus();
    });
    await t.page.keyboard.press('/');
    t.assert(
      await t.page.locator('#other-input').evaluate((e) => document.activeElement === e),
      'slash stays in editable',
    );
  }),
];
