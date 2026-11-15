import { defineJourney, waitFor } from '../lib/journey.mjs';
export const area = 'music';
export const targets = ['fixtures'];
const j = (id, title, steps) => defineJourney({ id, title, priority: 'P1', steps });
async function observeAudio(t) {
  await t.page.addInitScript(() => {
    const NativeAudio = window.Audio;
    window.Audio = function (...args) {
      const a = new NativeAudio(...args);
      (window.__qaAudio ||= []).push(a);
      return a;
    };
    window.Audio.prototype = NativeAudio.prototype;
  });
}
export const journeys = [
  j('G-music-play', 'Music playback, waveform and track switching', async (t) => {
    await observeAudio(t);
    await t.goto('/posts/music-deep/');
    await t.page.waitForFunction(() => window.__qaAudio?.length > 0);
    t.assertEqual(await t.page.locator('.music-track').count(), 2, 'two tracks');
    await t.page.locator('.music-track').first().click();
    await waitFor(() => t.page.evaluate(() => window.__qaAudio?.[0]?.currentTime > 0.2), {
      timeout: 12000,
      message: 'audio advances',
    });
    t.assert(await t.page.locator('[data-music-action="play"] .ri-pause-fill').count(), 'pause icon');
    const wave = t.page.locator('#music-waveform canvas');
    t.assert(await wave.isVisible(), 'waveform visible');
    await wave.click({ position: { x: (await wave.boundingBox()).width / 2, y: 20 } });
    t.assert(
      await t.page.evaluate(() => Math.abs(window.__qaAudio[0].currentTime - window.__qaAudio[0].duration / 2) < 1.5),
      'waveform seeks',
    );
    if (await t.page.evaluate(() => !!navigator.mediaSession))
      t.assertEqual(
        await t.page.evaluate(() => navigator.mediaSession.metadata?.title),
        '圆舞曲练习',
        'media metadata',
      );
    await t.page.locator('.music-track').nth(1).click();
    await waitFor(
      () =>
        t.page
          .locator('.music-track')
          .nth(1)
          .evaluate((e) => e.classList.contains('playing')),
      { timeout: 5000, message: 'second track active' },
    );
    t.assert(await t.page.evaluate(() => window.__qaAudio[0].src.endsWith('/track-2.mp3')), 'distinct second source');
    t.assertEqual(
      await t.page.evaluate(() => window.__qaAudio.filter((a) => !a.paused).length),
      1,
      'one audio playing',
    );
  }),
  ...['network', 'unsupported'].map((failure) =>
    j(`G-music-error-${failure}`, `Audio ${failure} failure, retry and track switching`, async (t) => {
      await observeAudio(t);
      const pattern = '**/track-1.mp3';
      const failAudio = (r) =>
        failure === 'network'
          ? r.abort()
          : r.fulfill({ status: 200, contentType: 'audio/mpeg', body: 'unsupported audio data' });
      await t.page.route(pattern, failAudio);
      await t.goto('/posts/music-deep/');
      await t.page.waitForFunction(() => window.__qaAudio?.length > 0);
      await t.page.locator('.music-track').first().click();
      const error = t.page.locator('.music-section .music-error[role="alert"]');
      await error.waitFor({ state: 'visible' });
      t.assert((await error.textContent()).length > 0, 'visible explanatory music error');
      t.assertEqual(await t.page.locator('.music-track').count(), 2, 'track list remains usable');
      await t.shot(`${failure}-error`);
      await t.page.unroute(pattern, failAudio);
      await t.page.locator('[data-music-action="play"]').click();
      await waitFor(() => t.page.evaluate(() => window.__qaAudio[0].currentTime > 0.2 && !window.__qaAudio[0].paused), {
        timeout: 12000,
        message: 'play retries failed source successfully',
      });
      t.assertEqual(await error.count(), 0, 'successful retry clears error');
      t.assert(await t.page.evaluate(() => window.__qaAudio[0].src.endsWith('/track-1.mp3')), 'retry keeps same track');
      await t.page.route(pattern, failAudio);
      await t.page.locator('.music-track').first().click();
      await error.waitFor({ state: 'visible' });
      await t.page.locator('.music-track').nth(1).click();
      await waitFor(
        () =>
          t.page.evaluate(
            () =>
              window.__qaAudio[0].src.endsWith('/track-2.mp3') &&
              window.__qaAudio[0].currentTime > 0.2 &&
              !window.__qaAudio[0].paused,
          ),
        {
          timeout: 12000,
          message: 'other track plays after failure',
        },
      );
      t.assertEqual(await error.count(), 0, 'track switch clears error');
      t.assertEqual(t.diagnostics.pageErrors.length, 0, 'no unhandled pageerror');
    }),
  ),
];
