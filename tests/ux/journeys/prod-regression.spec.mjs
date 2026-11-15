/**
 * Production spot-checks for the deep-QA overlay fixes (read-only).
 *
 * The fixture journeys prove the mechanics; these confirm the same behavior on
 * the live site with real media and content.
 */
import { defineJourney, waitFor } from '../lib/journey.mjs';
import { PROD } from '../lib/targets.mjs';

export const area = 'prod';
export const targets = ['prod'];

export const journeys = [
  defineJourney({
    id: 'prod-gallery-viewer',
    title: 'Production gallery viewer: zoom keys, Escape focus return, 44px close',
    priority: 'P1',
    steps: async (t) => {
      await t.goto('/posts/text-only/');
      const thumb = t.page.locator('.gallery-single img, .gallery-item img').first();
      await thumb.waitFor({ state: 'visible', timeout: 20000 });
      await thumb.click();
      const overlay = t.page.locator('#gallery-overlay, .gallery-overlay').first();
      await overlay.waitFor({ state: 'visible', timeout: 15000 });
      for (const selector of ['#gallery-done', '#gallery-fit', '#gallery-download']) {
        const control = t.page.locator(selector).first();
        const box = await control.boundingBox();
        t.assert(box && box.width >= 44 && box.height >= 44, `${selector} target is ${box?.width}x${box?.height}`);
      }
      await t.page.keyboard.press('+');
      await t.page.keyboard.press('Escape');
      await waitFor(async () => !(await overlay.isVisible()), { message: 'gallery closes on Escape' });
      await waitFor(
        async () =>
          t.page.evaluate(
            () =>
              document.activeElement?.tagName === 'IMG' ||
              document.activeElement?.closest?.('.gallery-item, .gallery-single-item'),
          ),
        { timeout: 8000, message: 'focus returns to the thumbnail' },
      );
    },
  }),
  defineJourney({
    id: 'prod-note-modal',
    title: 'Production note modal: deep link, mobile close target, 44px',
    priority: 'P1',
    viewport: 'mobile',
    steps: async (t) => {
      await t.goto('/?note=text-only');
      const dialog = t.page.locator('dialog.note-modal, .note-modal').first();
      await dialog.waitFor({ state: 'visible', timeout: 15000 });
      const close = t.page.locator('.note-close').first();
      const box = await close.boundingBox();
      t.assert(box && box.width >= 44 && box.height >= 44, `note close target is ${box?.width}x${box?.height}`);
      t.assert(t.page.url().includes('note=text-only'), 'deep link keeps the note query');
    },
  }),
  defineJourney({
    id: 'prod-feed-entry',
    title: 'Production vertical feed: entry opens, Escape closes, focus returns',
    priority: 'P1',
    steps: async (t) => {
      await t.goto('/');
      const entry = t.page.locator('.feed-entry-btn').first();
      await entry.waitFor({ state: 'visible', timeout: 20000 });
      await entry.click();
      const dialog = t.page.locator('dialog.feed-overlay').first();
      await dialog.waitFor({ state: 'visible', timeout: 15000 });
      await t.page.keyboard.press('Escape');
      await waitFor(async () => !(await dialog.isVisible()), { message: 'feed closes on Escape' });
      await waitFor(async () => t.page.evaluate(() => document.activeElement?.classList?.contains('feed-entry-btn')), {
        message: 'focus returns to the feed entry',
      });
    },
  }),
  defineJourney({
    id: 'prod-sitemap-taxonomy',
    title: 'Production sitemap and taxonomy routes are absolute and routable',
    priority: 'P2',
    steps: async (t) => {
      const base = PROD.site;
      const sitemap = await (await t.page.request.get(`${base}/sitemap.xml`)).text();
      const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      t.assert(locs.length >= 20, `sitemap locs=${locs.length}`);
      t.assert(
        locs.every((loc) => loc.startsWith('https://')),
        'all locs absolute',
      );
      const category = locs.find((loc) => loc.includes('/categories/'));
      t.assert(category, 'sitemap includes a category URL');
      const response = await t.page.request.get(category);
      t.assertEqual(response.status(), 200, 'category URL from sitemap is routable');
    },
  }),
];
