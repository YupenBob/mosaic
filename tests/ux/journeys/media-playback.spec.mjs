import { defineJourney, waitFor } from '../lib/journey.mjs';
import { mockPublicApi } from '../lib/browser.mjs';

export const area = 'media';
const post = '/posts/my-post/'; // selected from the local posts index; published HLS asset
const video = '.video-element';
async function setup(t, route = post) {
  await mockPublicApi(t.page);
  await t.goto(route);
}
async function play(t) {
  await t.page.locator('.video-big-play').first().click();
  await t.page.waitForFunction(
    () => {
      const v = document.querySelector('.video-element');
      return v && v.readyState >= 3 && !v.paused;
    },
    null,
    { timeout: 25000 },
  );
  const start = await t.page
    .locator(video)
    .first()
    .evaluate((v) => v.currentTime);
  await t.page.waitForFunction((s) => document.querySelector('.video-element').currentTime >= s + 1, start, {
    timeout: 15000,
  });
}
async function feed(t, viaCard = false) {
  await setup(t, '/');
  const index = await t.page.evaluate(() => fetch('/data/posts-index.json').then((r) => r.json()));
  const item = index.find((p) => p.slug === 'my-post' && p.media.videos.length);
  t.assert(item, 'expected indexed video');
  if (viaCard) await t.page.locator(`.post-card[data-slug="${item.slug}"]`).click();
  else await t.page.locator('.feed-entry-btn').click({ timeout: 15000 });
  await t.page.locator('[data-feed-stage]').waitFor({ state: 'visible', timeout: 15000 });
}
const journey = (id, title, steps, extra = {}) =>
  defineJourney({ id, title, priority: 'P1', timeoutMs: 70000, steps, ...extra });
export const journeys = [
  journey(
    'C-01',
    'HLS playback and quality switching',
    async (t) => {
      const requests = [];
      t.page.on('request', (r) => {
        if (/\.(m3u8|ts)(\?|$)/.test(r.url())) requests.push(r.url());
      });
      await setup(t);
      await play(t);
      t.assert(!(await t.page.locator('.video-error.show').count()), 'fatal error displayed');
      await t.page.locator('.video-controls').hover();
      await t.page.locator('.vc-quality-btn').click();
      const labels = await t.page.locator('.vc-quality-menu .vc-quality-label').allTextContents();
      t.note(`quality labels=${JSON.stringify(labels)} requests=${JSON.stringify(requests)}`);
      const manifest = requests.find((u) => /\.m3u8/.test(u));
      t.assert(manifest, 'HLS manifest requested');
      const body = await t.page.evaluate((u) => fetch(u).then((r) => r.text()), manifest);
      const heights = [...body.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => `${m[1]}p`);
      for (const tier of heights) t.assert(labels.includes(tier), `manifest tier ${tier} missing from ${labels}`);
      for (const tier of ['240p', '480p']) t.assert(labels.includes(tier), `${tier} missing`);
      const before = await t.page.locator(video).evaluate((v) => v.currentTime);
      await t.page.locator('.vc-quality-menu button').filter({ hasText: '240p' }).click();
      await t.page.waitForFunction((s) => document.querySelector('.video-element').currentTime >= s + 1, before, {
        timeout: 15000,
      });
    },
    { priority: 'P0' },
  ),
  journey('C-02', 'Seek using player keyboard', async (t) => {
    await setup(t);
    await play(t);
    const v = t.page.locator(video);
    const before = await v.evaluate((x) => x.currentTime);
    await t.page.locator('.vc-play').focus();
    await t.page.keyboard.press('ArrowRight');
    await t.page.waitForFunction((s) => document.querySelector('.video-element').currentTime >= s + 4, before, {
      timeout: 15000,
    });
    const after = await v.evaluate((x) => x.currentTime);
    await t.page.waitForFunction((s) => document.querySelector('.video-element').currentTime >= s + 1, after, {
      timeout: 15000,
    });
  }),
  journey('C-03', 'Mute, volume and fullscreen', async (t) => {
    await setup(t);
    await play(t);
    const v = t.page.locator(video);
    await t.page.locator('.video-controls').hover();
    await t.page.locator('.vc-volume-btn').click();
    t.assert(await v.evaluate((x) => x.muted), 'mute did not set muted');
    await t.page.locator('.vc-volume-btn').click();
    t.assert(!(await v.evaluate((x) => x.muted)), 'unmute failed');
    await t.page.locator('.vc-volume-range').fill('40');
    t.assert(Math.abs((await v.evaluate((x) => x.volume)) - 0.4) < 0.02, 'volume did not change');
    await t.page.evaluate(() => {
      window.__fsCalls = 0;
      const fn = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = function (...args) {
        window.__fsCalls++;
        return fn.apply(this, args);
      };
    });
    await t.page.locator('.vc-fullscreen').click();
    t.assertEqual(await t.page.evaluate(() => window.__fsCalls), 1, 'fullscreen request');
    t.note(`fullscreenElement=${await t.page.evaluate(() => !!document.fullscreenElement)}`);
  }),
  journey('C-04', 'Playlist selection and auto-advance', async (t) => {
    await setup(t, '/');
    const posts = await t.page.evaluate(() => fetch('/data/posts-index.json').then((r) => r.json()));
    const p = posts.find((x) => x.media.videos.length > 1);
    if (!p) throw new Error('BLOCKED: index contains no multi-video playlist post');
    await t.goto(`/posts/${p.slug}/`);
    t.assert(false, 'Playlist fixture requires selectors');
  }),
  journey('C-05', 'Feed lazy loading', async (t) => {
    const requests = [];
    t.page.on('request', (r) => {
      if (/\.(m3u8|ts)(\?|$)/.test(r.url())) requests.push(r.url());
    });
    await feed(t);
    await t.page.locator('.feed-slide video').first().waitFor({ timeout: 15000 });
    await t.page.waitForFunction(
      () => [...document.querySelectorAll('.feed-slide video')].some((v) => !v.paused && v.readyState >= 3),
      null,
      { timeout: 25000 },
    );
    const data = await t.page
      .locator('.feed-slide video')
      .evaluateAll((vs) => vs.map((v) => ({ preload: v.preload, paused: v.paused, src: v.currentSrc })));
    t.note(`videos=${JSON.stringify(data)} requests=${JSON.stringify(requests)}`);
    t.assert(
      requests.some((u) => /\.ts(\?|$)/.test(u)),
      'active video requested no fragments',
    );
    t.assert(
      requests.every((u) => u.includes('ast_2gx6yrwk7x5w1ed159ga82t7hs')),
      'inactive video requested HLS media',
    );
    t.assert(data.filter((v) => !v.paused).length <= 1, 'more than one video playing');
    t.assert(
      data.slice(1).every((v) => v.preload === 'none'),
      'inactive videos must preload none',
    );
  }),
  journey('C-06', 'Video card opens vertical feed', async (t) => {
    await feed(t, true);
  }),
  journey('C-10', 'Vertical feed keyboard navigation and close', async (t) => {
    await feed(t);
    await t.page.waitForFunction(
      () => [...document.querySelectorAll('.feed-slide video')].some((v) => !v.paused && v.readyState >= 3),
      null,
      { timeout: 25000 },
    );
    const before = await t.page.locator('[data-feed-counter]').textContent();
    const old = await t.page.locator('.feed-slide video').first().elementHandle();
    await t.page.keyboard.press('ArrowDown');
    await t.page.waitForFunction((x) => document.querySelector('[data-feed-counter]').textContent !== x, before, {
      timeout: 10000,
    });
    t.assert(await old.evaluate((v) => v.paused), 'old slide still playing');
    t.assert(
      await t.page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => !v.paused).length <= 1),
      'multiple videos playing',
    );
    await t.page.keyboard.press('ArrowUp');
    await t.page.waitForFunction((x) => document.querySelector('[data-feed-counter]').textContent === x, before, {
      timeout: 10000,
    });
    await t.page.locator('[data-feed-close]').click();
    await t.page.locator('[data-feed-stage]').waitFor({ state: 'hidden' });
    t.assert(new URL(t.page.url()).pathname === '/', 'did not return home');
  }),
  journey('C-07', 'Music playback and waveform', async (t) => {
    await setup(t, '/');
    const posts = await t.page.evaluate(() => fetch('/data/posts-index.json').then((r) => r.json()));
    const p = posts.find((x) => x.media.music.length);
    if (!p) throw new Error('BLOCKED: index contains no music post');
    t.assert(false, `Music fixture ${p.slug} requires selectors`);
  }),
  journey('C-08', 'Manifest failure recovers or shows error', async (t) => {
    let blocked = 0;
    await t.page.route('**/*.m3u8**', (r) => {
      blocked++;
      return r.abort('failed');
    });
    await setup(t);
    await t.page.locator('.video-big-play').first().click();
    await waitFor(
      async () =>
        (await t.page.locator('.video-error.show').count()) ||
        (await t.page.locator(video).evaluate((v) => !v.paused && v.readyState >= 3)),
      { timeout: 25000, message: 'fallback playback or visible error' },
    );
    t.assert(blocked > 0, 'manifest route was not requested');
    t.note(
      `blocked manifests=${blocked} error=${await t.page.locator('.video-error.show').count()} src=${await t.page.locator(video).evaluate((v) => v.currentSrc)}`,
    );
  }),
  journey('C-09', 'Mobile playback and feed swipe', async (t) => {
    const context = await t.context
      .browser()
      .newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
      await mockPublicApi(page);
      await page.goto(`${t.base}${post}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.video-big-play').first().tap();
      await page.waitForFunction(
        () => {
          let v = document.querySelector('.video-element');
          return v.readyState >= 3 && !v.paused;
        },
        null,
        { timeout: 25000 },
      );
      t.assert(await page.locator('.video-controls').isVisible(), 'controls hidden');
      t.assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
      await page.goto(t.base, { waitUntil: 'domcontentloaded' });
      await page.locator('.feed-entry-btn').tap({ timeout: 15000 });
      await page.locator('[data-feed-stage]').waitFor({ state: 'visible' });
      const before = await page.locator('[data-feed-counter]').textContent();
      const c = await context.newCDPSession(page);
      await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 650 }] });
      await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 300 }] });
      await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction((x) => document.querySelector('[data-feed-counter]').textContent !== x, before, {
        timeout: 10000,
      });
      await page.screenshot({ path: 'qa/reports/round-2/media-local/C-09-mobile.png' });
    } finally {
      await context.close();
    }
  }),
];
