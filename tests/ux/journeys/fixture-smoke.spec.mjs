/**
 * Fixture-site smoke: proves the throwaway fixture environment (playlist,
 * music, pagination, special taxonomy, XSS payloads) renders safely before the
 * deep journey specs rely on it.
 */
import { defineJourney, waitFor } from '../lib/journey.mjs';

export const area = 'fixtures';

export const journeys = [
  defineJourney({
    id: 'fixtures-pagination',
    title: 'Fixture home shows the first page and page/2 renders the next slice',
    priority: 'P0',
    steps: async (t) => {
      await t.goto('/');
      await waitFor(async () => (await t.page.locator('a.post-card').count()) === 20, {
        message: '20 cards on page 1',
      });
      await t.goto('/page/2/');
      await waitFor(async () => (await t.page.locator('a.post-card').count()) === 20, {
        message: '20 cards on page 2',
      });
      t.assert(t.page.url().includes('/page/2/'), 'page/2 URL');
    },
  }),
  defineJourney({
    id: 'fixtures-content-types',
    title: 'Playlist, music, gallery and mixed fixture posts render their sections',
    priority: 'P0',
    steps: async (t) => {
      await t.goto('/posts/playlist-deep/');
      t.assert((await t.page.locator('video').count()) >= 1, 'playlist post renders a video');
      t.assert((await t.page.locator('.pl-item').count()) >= 3, 'playlist lists 3 items');
      await t.goto('/posts/music-deep/');
      t.assert((await t.page.locator('.music-track, [data-music-track]').count()) >= 1, 'music post renders a track');
      await t.goto('/posts/gallery-deep/');
      t.assert(
        (await t.page.locator('.gallery-grid img, .gallery-single img, figure img').count()) >= 1,
        'gallery renders photos',
      );
      await t.goto('/posts/mixed-deep/');
      t.assert((await t.page.locator('pre code, .code-block').count()) >= 1, 'mixed post renders a code block');
      await t.note(`media base ${t.mediaUrl}`);
    },
  }),
  defineJourney({
    id: 'fixtures-xss-fields',
    title: 'Metadata payloads are escaped; authored body HTML is a documented trust decision',
    priority: 'P0',
    steps: async (t) => {
      await t.goto('/posts/xss-deep/');
      await t.sleep(400);
      t.assertEqual(await t.page.evaluate(() => window.__xss || 0), 0, 'no metadata payload executed');
      const title = await t.page.locator('h1').first().innerText();
      t.assert(title.includes('<img'), 'payload text is escaped and visible as text');
      // Body raw HTML is authored content (repo/admin author) and renders by
      // design; assert it so the trust boundary is explicit and regressions show.
      await t.goto('/posts/trusted-html-deep/');
      await waitFor(async () => (await t.page.evaluate(() => window.__trusted)) === 3, {
        message: 'authored body HTML renders',
      });
      t.note('body HTML is trusted author content; metadata/taxonomy/query/hash must stay escaped');
    },
  }),
  defineJourney({
    id: 'fixtures-taxonomy',
    title: 'Nested and special-character taxonomy pages route correctly',
    priority: 'P1',
    steps: async (t) => {
      for (const route of ['/categories/摄影/胶片/', '/categories/分页/', '/tags/分页/', '/tags/xss-test/']) {
        const response = await t.page.request.get(`${t.base}${route}`);
        t.assertEqual(response.status(), 200, `${route} status`);
        t.assert((await response.text()).length > 200, `${route} content`);
      }
    },
  }),
];
