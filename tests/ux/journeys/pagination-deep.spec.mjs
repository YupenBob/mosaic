import { defineJourney, waitFor } from '../lib/journey.mjs';
export const area = 'pagination';
export const targets = ['fixtures'];
const j = (id, title, steps) => defineJourney({ id, title, priority: 'P1', steps });
export const journeys = [
  j('G-pagination-pages', 'Page slices, links, canonical and history', async (t) => {
    await t.goto('/');
    const first = await t.page.locator('a.post-card').evaluateAll((es) => es.map((e) => e.href));
    t.assertEqual(first.length, 20, 'first page count');
    await t.goto('/page/2/');
    const second = await t.page.locator('a.post-card').evaluateAll((es) => es.map((e) => e.href));
    t.assertEqual(second.length, 20, 'second page count');
    t.assert(!second.some((x) => first.includes(x)), 'disjoint slices');
    t.assert(
      (await t.page.locator('link[rel=canonical]').getAttribute('href')).endsWith('/page/2/'),
      'canonical page 2',
    );
    const links = await t.page.locator('.pagination a').evaluateAll((es) => es.map((e) => e.href));
    t.assert(
      links.some((x) => /\/page\/3\/(index\.html)?$/.test(x)),
      'next link',
    );
    await t.page.evaluate(() => window.scrollTo(0, 500));
    const scroll = await t.page.evaluate(() => scrollY);
    await t.goto('/page/4/');
    t.assertEqual(await t.page.locator('a.post-card').count(), 5, 'last page remainder');
    await t.page.goBack();
    await waitFor(() => t.page.url().includes('/page/2/'), { message: 'back' });
    t.assertEqual(await t.page.locator('a.post-card').count(), 20, 'back slice');
    t.note(`scroll before navigation ${scroll}, restored ${await t.page.evaluate(() => scrollY)}`);
    await t.page.goForward();
    t.assertEqual(await t.page.locator('a.post-card').count(), 5, 'forward slice');
  }),
  j('G-pagination-taxonomy', 'Encoded taxonomy routes', async (t) => {
    for (const [route, slug] of [
      ['/categories/摄影/胶片/', 'mixed-deep'],
      // Spaces are slugified by the generator; this is the sole canonical tag route.
      ['/tags/标签-空格/', 'xss-deep'],
    ]) {
      const r = await t.goto(route);
      t.assertEqual(r.status(), 200, `${route} status`);
      t.assert(await t.page.locator(`a.post-card[href*="${slug}"]`).count(), `${route} matching post`);
      t.note(
        `${route} active navigation: ${await t.page.locator('.header-nav .active, .header-nav [aria-current]').count()}`,
      );
    }
  }),
  j('G-pagination-sitemap', 'Sitemap and unknown routes', async (t) => {
    const r = await t.page.request.get(`${t.base}/sitemap.xml`);
    t.assertEqual(r.status(), 200, 'sitemap status');
    const xml = await r.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    t.assertEqual((xml.match(/<url>/g) || []).length, (xml.match(/<\/url>/g) || []).length, 'balanced url tags');
    t.assertEqual((xml.match(/<loc>/g) || []).length, (xml.match(/<\/loc>/g) || []).length, 'balanced loc tags');
    t.assert(
      locs.every((x) => /^https?:\/\//.test(x)),
      'absolute locations',
    );
    t.assertEqual(
      locs.filter((x) => x.includes('/posts/')).length,
      65,
      '65 post locations (including wallpaper fixture)',
    );
    t.assertEqual(
      JSON.stringify(locs.filter((x) => x.includes('/page/')).map((x) => new URL(x).pathname)),
      JSON.stringify(['/page/2/', '/page/3/', '/page/4/']),
      'all home listing pages',
    );
    t.assert(
      locs.some((x) => decodeURI(x).endsWith('/tags/标签-空格/')),
      'canonical slugified tag in sitemap',
    );
    t.assert(
      locs.some((x) => x.includes('/categories/')) && locs.some((x) => x.includes('/tags/')),
      'taxonomy locations',
    );
    for (const route of ['/page/999/', '/categories/nonexistent-qa/']) {
      const response = await t.goto(route);
      t.assertEqual(response.status(), 404, `${route} 404`);
      const href = await t.page.locator('a').first().getAttribute('href');
      t.note(`404 first link: ${href}`);
    }
  }),
];
