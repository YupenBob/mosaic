import { defineJourney, waitFor } from '../lib/journey.mjs';
export const area = 'note';
const modal = (t) => t.page.locator('dialog.note-modal[open]');
async function deep(t, slug) {
  await t.goto(`/?note=${slug}`);
  await modal(t).locator('.note-panel:not([aria-busy])').waitFor();
}
export const journeys = [
  defineJourney({
    id: 'F-11',
    title: 'Card, history, focus and dismissal',
    steps: async (t) => {
      await t.goto('/');
      const card = t.page.locator('a.post-card').first();
      const slug = await card.getAttribute('data-slug');
      await card.click();
      await modal(t).locator('.note-panel:not([aria-busy])').waitFor();
      t.assertEqual(new URL(t.page.url()).searchParams.get('note'), slug, 'note URL');
      await t.shot('open');
      await t.page.goBack();
      await modal(t).waitFor({ state: 'hidden' });
      t.assert(await card.evaluate((e) => e === document.activeElement), 'focus returns');
      await card.click();
      await modal(t).locator('.note-panel:not([aria-busy])').waitFor();
      await t.page.keyboard.press('Escape');
      await modal(t).waitFor({ state: 'hidden' });
      await card.click();
      await modal(t).locator('.note-panel:not([aria-busy])').waitFor();
      await modal(t).click({ position: { x: 2, y: 2 }, force: true });
      await modal(t).waitFor({ state: 'hidden' });
    },
  }),
  defineJourney({
    id: 'F-12',
    title: 'Gallery carousel and keyboard',
    steps: async (t) => {
      await t.page.emulateMedia({ reducedMotion: 'reduce' });
      await deep(t, 'gallery-deep');
      const d = modal(t);
      t.assertEqual(await d.locator('.note-media-item').count(), 4, 'four photos');
      t.assert(await d.locator('.note-media-nav.prev').isDisabled(), 'previous disabled at start');
      await d.locator('.note-media-nav.next').click();
      await waitFor(
        async () => (await d.locator('.note-dot.active').evaluate((e) => [...e.parentNode.children].indexOf(e))) === 1,
        { message: 'second photo' },
      );
      await t.page.keyboard.press('ArrowRight');
      await waitFor(
        async () => (await d.locator('.note-dot.active').evaluate((e) => [...e.parentNode.children].indexOf(e))) === 2,
        { message: 'third photo' },
      );
      await t.page.keyboard.press('ArrowRight');
      await waitFor(async () => await d.locator('.note-media-nav.next').isDisabled(), { message: 'last boundary' });
      await t.page.keyboard.press('ArrowLeft');
      await waitFor(async () => !(await d.locator('.note-media-nav.next').isDisabled()), { message: 'previous photo' });
      t.assertEqual(await d.locator('.note-dots .note-dot').count(), 4, 'four position dots');
      t.assertEqual(
        await d.locator('.note-media-counter[aria-live="polite"]').innerText(),
        '3 / 4',
        'numeric live counter follows keyboard navigation',
      );
      await t.shot('carousel');
    },
  }),
  defineJourney({
    id: 'F-13',
    title: 'Video and music playback',
    steps: async (t) => {
      await deep(t, 'playlist-deep');
      const play = modal(t).locator('[data-video-index]').first();
      await play.click();
      const v = modal(t).locator('video').first();
      await v.waitFor();
      await waitFor(async () => await v.evaluate((e) => !e.paused), { message: 'video playing' });
      t.assertEqual(await modal(t).locator('video').count(), 1, 'one video mounted');
      await t.shot('video');
      await deep(t, 'music-deep');
      const music = modal(t).locator('[data-audio-src]').first();
      await music.click();
      await waitFor(async () => await music.evaluate((e) => e.classList.contains('playing')), {
        message: 'music playing indicator',
      });
      await t.shot('music');
    },
  }),
  defineJourney({
    id: 'F-14',
    title: 'Share, focus trap and scroll lock',
    steps: async (t) => {
      await t.page.addInitScript(() => {
        Object.defineProperty(navigator, 'share', { value: undefined });
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            writeText: async (s) => {
              window.__copied = s;
            },
          },
        });
      });
      await deep(t, 'gallery-deep');
      const d = modal(t);
      t.assertEqual(await t.page.evaluate(() => document.body.style.overflow), 'hidden', 'scroll locked');
      const y = await t.page.evaluate(() => scrollY);
      await t.page.mouse.wheel(0, 500);
      t.assertEqual(await t.page.evaluate(() => scrollY), y, 'background remains fixed');
      t.assertEqual(await d.evaluate((e) => e.tagName), 'DIALOG', 'native dialog semantics');
      for (let i = 0; i < 15; i++) {
        await t.page.keyboard.press('Tab');
        t.assert(await d.evaluate((e) => e.contains(document.activeElement)), 'focus stays in dialog');
      }
      const url = t.page.url();
      await d.locator('[data-note-share]').click();
      await waitFor(async () => !!(await t.page.evaluate(() => window.__copied)), { message: 'share copied' });
      t.assertEqual(await t.page.evaluate(() => window.__copied), url, 'stable note URL');
      t.assertEqual(t.page.url(), url, 'share does not navigate');
      await t.shot('share');
      await t.page.keyboard.press('Escape');
      await d.waitFor({ state: 'hidden' });
    },
  }),
  defineJourney({
    id: 'F-15',
    title: 'Untrusted query and metadata',
    steps: async (t) => {
      await t.goto('/?note=' + encodeURIComponent('<script>window.__xss=1</script>'));
      await t.page.locator('dialog.note-modal[open]').waitFor();
      t.assertEqual(await t.page.evaluate(() => window.__xss || 0), 0, 'query did not execute');
      await t.page.keyboard.press('Escape');
      await modal(t).waitFor({ state: 'hidden' });
      await deep(t, 'xss-deep');
      t.assertEqual(await t.page.evaluate(() => window.__xss || 0), 0, 'metadata did not execute');
      t.assert((await modal(t).innerText()).includes('<img'), 'payload displayed as text');
      t.assertEqual(await modal(t).locator('img[onerror], script').count(), 0, 'no executable metadata');
      await t.shot('xss');
    },
  }),
  defineJourney({
    id: 'F-16',
    title: 'Mobile modal layout and carousel swipe',
    viewport: 'mobile',
    steps: async (t) => {
      await deep(t, 'gallery-deep');
      const d = modal(t);
      const panel = await d.locator('.note-panel').boundingBox();
      t.assert(panel.x >= 0 && panel.x + panel.width <= 391, 'panel fits viewport');
      const close = await d.locator('[data-note-close]').boundingBox();
      t.assert(close.width >= 44 && close.height >= 44, '44px mobile close target');
      const c = await t.context.newCDPSession(t.page);
      await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 320, y: 250 }] });
      await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 80, y: 250 }] });
      await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitFor(
        async () => (await d.locator('.note-dot.active').evaluate((e) => [...e.parentNode.children].indexOf(e))) > 0,
        { message: 'swipe advances carousel' },
      );
      await t.shot('mobile');
    },
  }),
];
