import { defineJourney, waitFor } from '../lib/journey.mjs';
export const area = 'feed';
const open = async (t) => {
  await t.goto('/');
  await t.page.locator('.feed-entry-btn').click();
  await t.page.locator('dialog.feed-overlay[open] [data-feed-stage]').waitFor();
};
const active = (t) => t.page.locator('dialog.feed-overlay').getAttribute('data-active');
const go = async (t, key, n) => {
  await t.page.keyboard.press(key);
  await waitFor(async () => (await active(t)) === String(n), { message: `feed slide ${n}` });
};
async function swipe(t) {
  const c = await t.context.newCDPSession(t.page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 650 }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 250 }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach();
}
export const journeys = [
  defineJourney({
    id: 'F-01',
    title: 'Feed lifecycle, scroll and focus',
    steps: async (t) => {
      await open(t);
      t.assertEqual(await t.page.evaluate(() => document.body.style.overflow), 'hidden', 'scroll locked');
      await t.shot('open');
      await t.page.locator('[data-feed-close]').click();
      await t.page.locator('dialog.feed-overlay').waitFor({ state: 'detached' });
      t.assert(await t.page.locator('.feed-entry-btn').evaluate((e) => e === document.activeElement), 'entry focused');
      t.assertEqual(await t.page.evaluate(() => document.body.style.overflow), '', 'scroll restored');
      for (let i = 0; i < 3; i++) {
        await t.page.locator('.feed-entry-btn').click();
        await t.page.locator('dialog.feed-overlay[open]').waitFor();
        t.assertEqual(await t.page.locator('dialog.feed-overlay').count(), 1, 'one dialog');
        await t.page.keyboard.press('Escape');
        await t.page.locator('dialog.feed-overlay').waitFor({ state: 'detached' });
      }
      t.assertEqual(await t.page.locator('.feed-entry-btn').count(), 1, 'one entry');
      await t.page.locator('.feed-entry-btn').click();
      await t.page.locator('dialog.feed-overlay[open]').waitFor();
      await t.page.locator('.feed-slide.is-active').click({ position: { x: 100, y: 200 } });
      t.assertEqual(await t.page.locator('dialog.feed-overlay[open]').count(), 1, 'slide click keeps feed open');
      await t.page.locator('dialog.feed-overlay').click({ position: { x: 1, y: 1 }, force: true });
      await t.page.locator('dialog.feed-overlay').waitFor({ state: 'detached' });
      t.assert(
        await t.page.locator('.feed-entry-btn').evaluate((e) => e === document.activeElement),
        'backdrop restores entry focus',
      );
    },
  }),
  defineJourney({
    id: 'F-02',
    title: 'Feed navigation and playback window',
    steps: async (t) => {
      await open(t);
      const d = t.page.locator('dialog.feed-overlay');
      const count = await d.locator('.feed-slide').count();
      t.assert(count > 1, 'multiple video posts');
      await waitFor(async () => (await d.locator('video').count()) > 0, { message: 'video mounted' });
      await t.page.keyboard.press('ArrowUp');
      t.assertEqual(await active(t), '0', 'first boundary');
      const previous = d.locator('.feed-slide[data-index="0"] video');
      await go(t, 'ArrowDown', 1);
      t.assert(await previous.evaluate((e) => e.paused), 'previous video paused');
      t.assertEqual((await d.locator('[data-feed-counter]').innerText()).split('/')[0], '2', 'counter');
      t.assert(
        await d.evaluate((el) => [...el.querySelectorAll('video')].filter((v) => !v.paused).length <= 1),
        'at most one playing',
      );
      t.assert(
        await d.evaluate((el) =>
          [...el.querySelectorAll('.feed-slide')].every(
            (s) => Math.abs(+s.dataset.index - 1) <= 1 || !s.querySelector('video'),
          ),
        ),
        'outside window unmounted',
      );
      await go(t, 'ArrowUp', 0);
      await t.page.locator('[data-feed-stage]').hover();
      await t.page.mouse.wheel(0, 150);
      await waitFor(async () => (await active(t)) === '1', { message: 'wheel down' });
      await t.page.waitForFunction(() => performance.now() > 0);
      await t.shot('navigation');
      for (let i = 2; i < count; i++) await go(t, 'ArrowDown', i);
      await t.page.keyboard.press('ArrowDown');
      t.assertEqual(await active(t), String(count - 1), 'last boundary');
      t.note('Wheel events are debounced for 380ms; keyboard tests cover reverse navigation.');
    },
  }),
  defineJourney({
    id: 'F-03',
    title: 'Mute and progress',
    steps: async (t) => {
      await open(t);
      const v = t.page.locator('.feed-slide.is-active video');
      await v.waitFor();
      const mute = t.page.locator('[data-feed-mute]');
      const before = await mute.getAttribute('aria-pressed');
      await mute.click();
      t.assert((await mute.getAttribute('aria-pressed')) !== before, 'mute aria toggled');
      t.assertEqual(await v.evaluate((e) => e.muted), before === 'false', 'video muted state');
      await waitFor(async () => await v.evaluate((e) => Number.isFinite(e.duration) && e.duration > 0), {
        message: 'video duration',
      });
      await v.evaluate((e) => {
        e.currentTime = e.duration / 2;
        e.dispatchEvent(new Event('timeupdate'));
      });
      await waitFor(
        async () => Number(await t.page.locator('[data-feed-progress]').getAttribute('aria-valuenow')) > 0,
        { message: 'progress reflects playback' },
      );
      await t.shot('progress');
    },
  }),
  defineJourney({
    id: 'F-04',
    title: 'Video-only feed and shareable URL state',
    steps: async (t) => {
      await open(t);
      const slugs = await t.page.locator('.feed-slide').evaluateAll((es) => es.map((e) => e.dataset.slug));
      for (const slug of ['music-deep', 'gallery-deep']) t.assert(!slugs.includes(slug), `${slug} excluded`);
      t.assert(slugs.includes('mixed-deep'), 'mixed post with video included');
      await go(t, 'ArrowDown', 1);
      const slug = await t.page.locator('.feed-slide.is-active').getAttribute('data-slug');
      t.assertEqual(new URL(t.page.url()).searchParams.get('feed'), slug, 'active slide in URL');
      await t.page.reload();
      await t.page.locator('dialog.feed-overlay[open]').waitFor();
      await waitFor(async () => (await t.page.locator('.feed-slide.is-active').getAttribute('data-slug')) === slug, {
        message: 'deep link reopens selected slide',
      });
      t.note('FEED-03: feed intentionally stays video-only; see docs/qa/round-5-decisions.md.');
      await t.shot('filtered');
    },
  }),
  defineJourney({
    id: 'F-05',
    title: 'Mobile swipe and close target',
    viewport: 'mobile',
    steps: async (t) => {
      await open(t);
      const box = await t.page.locator('[data-feed-close]').boundingBox();
      t.assert(box.width >= 44 && box.height >= 44, '44px close target');
      await swipe(t);
      await waitFor(async () => (await active(t)) === '1', { message: 'mobile swipe' });
      await t.shot('mobile');
    },
  }),
];
