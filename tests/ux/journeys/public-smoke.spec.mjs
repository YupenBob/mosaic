/**
 * Harness smoke journeys: prove the local QA build + system Chromium + runner
 * wiring before real domain journeys are written.
 */
import { defineJourney, waitFor } from '../lib/journey.mjs';

export const area = 'public';

export const journeys = [
  defineJourney({
    id: 'public-smoke-home',
    title: 'Home page renders the masonry feed with 14 posts',
    priority: 'P0',
    steps: async (t) => {
      await t.goto('/');
      const cards = t.page.locator('[data-feed-item], .post-card, article');
      await waitFor(async () => (await cards.count()) >= 14, { message: '14 feed cards' });
      const count = await cards.count();
      t.assert(count >= 14, `expected at least 14 feed cards, got ${count}`);
      const title = await t.page.title();
      t.assert(title.length > 0, 'document title should not be empty');
      await t.note(`cards=${count} title=${title}`);
    },
  }),
  defineJourney({
    id: 'public-smoke-theme-toggle',
    title: 'Theme toggle switches light to dark and persists',
    priority: 'P0',
    steps: async (t) => {
      await t.goto('/');
      const toggle = t.page.locator('#theme-menu-toggle');
      await toggle.waitFor({ state: 'visible', timeout: 15000 });
      const before = await t.page.evaluate(() => document.documentElement.dataset.theme);
      await toggle.click();
      const target = before === 'dark' ? 'light' : 'dark';
      await t.page.locator(`#theme-menu label.theme-mode:has(input[value="${target}"])`).click();
      await waitFor(async () => (await t.page.evaluate(() => document.documentElement.dataset.theme)) !== before, {
        message: 'theme attribute change',
      });
      await t.page.reload({ waitUntil: 'domcontentloaded' });
      const afterReload = await t.page.evaluate(() => localStorage.getItem('mosaic_theme'));
      t.assert(afterReload !== null, 'theme choice should persist in localStorage');
      await t.note(`theme ${before} -> ${afterReload}`);
    },
  }),
  defineJourney({
    id: 'public-smoke-post-page',
    title: 'A post page loads from the feed and renders its content',
    priority: 'P0',
    steps: async (t) => {
      await t.goto('/');
      const firstLink = t.page.locator('a.post-card').first();
      await firstLink.waitFor({ state: 'visible', timeout: 15000 });
      const href = await firstLink.getAttribute('href');
      await t.goto(href);
      await waitFor(async () => (await t.page.locator('article, main').count()) > 0, { message: 'post article' });
      const heading = await t.page.locator('h1').first().textContent();
      t.assert((heading || '').trim().length > 0, 'post page should render an h1');
      await t.note(`post=${href} heading=${heading}`);
    },
  }),
];
