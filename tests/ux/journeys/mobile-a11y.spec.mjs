import path from 'node:path';
import { defineJourney } from '../lib/journey.mjs';
import { mockPublicApi } from '../lib/browser.mjs';

export const area = 'a11y';
const setup = async (t) => {
  await mockPublicApi(t.page);
};
async function routes(t) {
  const posts = await (await t.page.request.get(`${t.base}/data/posts-index.json`)).json();
  const cats = await (await t.page.request.get(`${t.base}/data/categories.json`)).json();
  const gallery = posts.find((p) => p.media?.gallery?.length);
  const video = posts.find((p) => p.media?.videos?.length);
  const text = posts.find((p) => !p.media?.gallery?.length && !p.media?.videos?.length && !p.media?.music?.length);
  t.assert(gallery && video && text && cats[0], 'representative content must exist');
  return [
    '/',
    `/posts/${gallery.slug}/`,
    `/posts/${video.slug}/`,
    `/posts/${text.slug}/`,
    `/categories/${cats[0].slug}/`,
    '/404.html',
  ];
}
const journey = (id, title, steps, options = {}) =>
  defineJourney({
    id,
    title,
    priority: 'P1',
    assertNoErrors: false,
    ...options,
    steps: async (t) => {
      await setup(t);
      await steps(t);
    },
  });
export const journeys = [
  journey(
    'D-01',
    'Mobile layout, navigation and targets',
    async (t) => {
      const paths = await routes(t),
        failures = [];
      for (const width of [390, 360]) {
        await t.page.setViewportSize({ width, height: 844 });
        for (const url of paths) {
          await t.goto(url);
          const m = await t.page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
            nav: !!document.querySelector('nav'),
          }));
          t.note(`${width} ${url} ${JSON.stringify(m)}`);
          if (m.scroll > m.client + 1) failures.push(`${width} ${url} overflow ${m.scroll}/${m.client}`);
        }
        await t.goto('/');
        const toggle = t.page.locator('#theme-menu-toggle');
        await toggle.click();
        t.assert((await toggle.getAttribute('aria-expanded')) === 'true', 'theme menu opens');
        await toggle.click();
        t.assert((await toggle.getAttribute('aria-expanded')) === 'false', 'theme menu closes');
        for (const [name, sel] of [
          ['theme', '#theme-menu-toggle'],
          ['card', 'a.post-card'],
        ]) {
          const box = await t.page.locator(sel).first().boundingBox();
          t.note(`${width} ${name}=${JSON.stringify(box)}`);
          if (!box || box.width < 44 || box.height < 44)
            failures.push(`${width} ${name} target ${JSON.stringify(box)}`);
        }
        await t.goto(paths[1]);
        const like = t.page.locator('.like-button').first();
        if (await like.count()) {
          const box = await like.boundingBox();
          t.note(`${width} like=${JSON.stringify(box)}`);
          if (!box || box.width < 44 || box.height < 44) failures.push(`${width} like target ${JSON.stringify(box)}`);
        } else failures.push('like control missing');
        await t.goto('/');
        await t.page.locator('.feed-entry-btn').click({ timeout: 8000 });
        const close = t.page.locator('[data-feed-close]');
        if (await close.isVisible({ timeout: 3000 }).catch(() => false)) {
          const box = await close.boundingBox();
          t.note(`${width} feed-close=${JSON.stringify(box)}`);
          if (!box || box.width < 44 || box.height < 44)
            failures.push(`${width} feed-close target ${JSON.stringify(box)}`);
        } else failures.push('feed close not visible');
      }
      t.assert(!failures.length, failures.join('; '));
    },
    { viewport: 'mobile' },
  ),
  journey('D-02', 'Keyboard navigation and theme menu', async (t) => {
    await t.goto('/');
    const sequence = [];
    for (let i = 0; i < 12; i++) {
      await t.page.keyboard.press('Tab');
      sequence.push(
        await t.page.evaluate(() => ({
          tag: document.activeElement.tagName,
          id: document.activeElement.id,
          text: (document.activeElement.getAttribute('aria-label') || document.activeElement.textContent || '')
            .trim()
            .slice(0, 60),
          outline: getComputedStyle(document.activeElement).outlineStyle,
        })),
      );
    }
    t.note(`tabOrder=${JSON.stringify(sequence)}`);
    const toggle = t.page.locator('#theme-menu-toggle');
    await toggle.focus();
    await t.page.keyboard.press('Enter');
    const open = await toggle.getAttribute('aria-expanded');
    await t.page.keyboard.press('Tab');
    const focus = await t.page.evaluate(() => ({
      tag: document.activeElement.tagName,
      outer: document.activeElement.outerHTML.slice(0, 300),
    }));
    await t.page.keyboard.press('ArrowDown');
    await t.page.keyboard.press('Space');
    await t.page.keyboard.press('Escape');
    const end = await t.page.evaluate(() => ({
      active: document.activeElement.id,
      expanded: document.querySelector('#theme-menu-toggle').getAttribute('aria-expanded'),
    }));
    t.note(`open=${open} focus=${JSON.stringify(focus)} end=${JSON.stringify(end)}`);
    t.assert(
      open === 'true' && end.expanded === 'false' && end.active === 'theme-menu-toggle',
      'keyboard theme menu should close on Escape and return focus',
    );
  }),
  journey('D-03', 'Landmarks, names, image and video semantics', async (t) => {
    const paths = await routes(t);
    await t.goto('/');
    const home = await t.page.evaluate(() => ({
      landmarks: Object.fromEntries(
        ['header', 'nav', 'main', 'footer', 'h1'].map((s) => [s, document.querySelectorAll(s).length]),
      ),
      unnamedCards: [...document.querySelectorAll('a.post-card')].filter(
        (e) => !(e.getAttribute('aria-label') || e.innerText || e.querySelector('img')?.alt || '').trim(),
      ).length,
      missingAlt: document.querySelectorAll('img:not([alt])').length,
      skip: [...document.querySelectorAll('a')].filter((a) => /skip|跳过/i.test(a.textContent)).map((a) => a.outerHTML),
    }));
    t.note(`home=${JSON.stringify(home)}`);
    await t.goto(paths[2]);
    const videos = await t.page.locator('video').evaluateAll((es) =>
      es.map((e) => ({
        label: e.getAttribute('aria-label'),
        labelledby: e.getAttribute('aria-labelledby'),
        captions: e.querySelectorAll('track[kind="captions"],track[kind="subtitles"]').length,
      })),
    );
    t.note(`videos=${JSON.stringify(videos)}`);
    t.assert(
      home.landmarks.header &&
        home.landmarks.nav &&
        home.landmarks.main &&
        home.landmarks.footer &&
        home.landmarks.h1 === 1 &&
        !home.unnamedCards &&
        !home.missingAlt &&
        videos.length > 0 &&
        videos.every((v) => v.label || v.labelledby),
      'home landmarks, h1, card names, image alt and video labels required',
    );
  }),
  journey('D-04', 'Reduced motion', async (t) => {
    await t.page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await t.goto('/');
    const m = await t.page.evaluate(() => ({
      matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
      motion: document.documentElement.dataset.motion,
      animations: document.getAnimations().map((a) => ({
        duration: a.effect?.getComputedTiming().duration,
        iterations: a.effect?.getComputedTiming().iterations,
        playState: a.playState,
      })),
      hidden: [...document.querySelectorAll('[data-motion]')].filter((e) => getComputedStyle(e).opacity === '0').length,
    }));
    t.note(JSON.stringify(m));
    t.assert(
      m.matches && !m.hidden && !m.animations.some((a) => a.iterations === null || a.iterations === Infinity),
      'reduced motion should be visible without infinite animation',
    );
  }),
  journey(
    'D-05',
    'Axe WCAG 2.2 AA on six surfaces in light and dark',
    async (t) => {
      const paths = await routes(t),
        bad = [];
      for (const theme of ['light', 'dark'])
        for (const url of paths) {
          await t.page.emulateMedia({ colorScheme: theme });
          await t.goto(url);
          await t.page.evaluate((theme) => localStorage.setItem('mosaic_theme', theme), theme);
          await t.page.reload({ waitUntil: 'domcontentloaded' });
          await t.page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
          const results = await t.page.evaluate(async () => {
            const r = await globalThis.axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
            });
            return r.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
            }));
          });
          t.note(`${theme} ${url} ${JSON.stringify(results)}`);
          const serious = results.filter((x) => ['critical', 'serious'].includes(x.impact));
          if (serious.length) bad.push(`${theme} ${url}: ${JSON.stringify(serious)}`);
        }
      t.assert(!bad.length, bad.join('; '));
    },
    { timeoutMs: 150000 },
  ),
  journey('D-06', '320px reflow and 200% zoom', async (t) => {
    const paths = await routes(t),
      bad = [];
    await t.page.setViewportSize({ width: 320, height: 800 });
    for (const url of [paths[0], paths[1]])
      for (const zoom of [1, 2]) {
        await t.goto(url);
        await t.page.evaluate((z) => (document.body.style.zoom = z), zoom);
        const m = await t.page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        t.note(`${url} zoom=${zoom} ${JSON.stringify(m)}`);
        if (m.scroll > m.client + 1) bad.push(`${url} zoom ${zoom} ${JSON.stringify(m)}`);
      }
    t.assert(!bad.length, bad.join('; '));
  }),
  journey(
    'D-07',
    'Delayed media and page usability',
    async (t) => {
      await t.page.route(/mosaic-media\.xsanye\.cn/, async (route) => {
        await new Promise((r) => setTimeout(r, 800));
        await route.continue();
      });
      await t.goto('/');
      const m = await t.page.evaluate(() => ({
        cards: document.querySelectorAll('a.post-card').length,
        images: [...document.images]
          .slice(0, 8)
          .map((i) => ({ src: i.currentSrc, complete: i.complete, naturalWidth: i.naturalWidth })),
        skeleton: document.querySelectorAll('[class*="skeleton"], [class*="lqip"]').length,
      }));
      t.note(`initial=${JSON.stringify(m)}`);
      await t.page.locator('#theme-menu-toggle').click();
      t.assert(
        (await t.page.locator('#theme-menu-toggle').getAttribute('aria-expanded')) === 'true',
        'menu usable while media delayed',
      );
      await t.page.waitForTimeout(2500);
      const end = await t.page.evaluate(() => ({
        loaded: [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length,
        pending: [...document.images].filter((i) => !i.complete).length,
      }));
      t.note(`settled=${JSON.stringify(end)}`);
      t.assert(end.loaded > 0, 'at least one image should load');
    },
    { viewport: 'mobile' },
  ),
];
