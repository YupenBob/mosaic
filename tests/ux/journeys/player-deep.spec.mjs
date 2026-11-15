import { defineJourney, waitFor } from '../lib/journey.mjs';
export const area = 'player';
export const targets = ['fixtures'];
const j = (id, title, steps) => defineJourney({ id, title, priority: 'P1', steps });
const ready = (t) =>
  t.page
    .locator('video:visible')
    .first()
    .evaluate((v) => v.readyState >= 2);
const play = async (t) => {
  const button = t.page.locator('.video-big-play:visible').first();
  await button.waitFor({ state: 'visible', timeout: 15000 });
  await button.click();
  try {
    await waitFor(() => ready(t), { timeout: 12000, message: 'video ready' });
  } catch {
    // Native <video> attach can race the first click on a loaded host; a second
    // explicit intent is the user-equivalent recovery.
    await button.click();
    await waitFor(() => ready(t), { timeout: 20000, message: 'video ready (retry)' });
  }
};
export const journeys = [
  j('G-player-intent', 'Intent gated HLS and controls', async (t) => {
    const requests = [];
    t.page.on('request', (r) => {
      if (/\.(m3u8|ts)(\?|$)/.test(r.url())) requests.push(r.url());
    });
    await t.goto('/posts/single-video/');
    await t.page.waitForLoadState('networkidle');
    t.assertEqual(requests.length, 0, 'no HLS before intent');
    await play(t);
    await waitFor(() => requests.some((x) => /\.ts(\?|$)/.test(x)), { timeout: 15000, message: 'segment' });
    const v = t.page.locator('video').first();
    t.assert(await v.getAttribute('aria-label'), 'video has label');
    await t.page.locator('.vc-volume-btn').click();
    t.assert(await v.evaluate((x) => x.muted), 'mute');
    await t.page.locator('.vc-volume-btn').click();
    t.assert(!(await v.evaluate((x) => x.muted)), 'unmute');
    await t.page.locator('.vc-speed-btn').click();
    await t.page.locator('[data-speed="1.5"]').click();
    t.assertEqual(await v.evaluate((x) => x.playbackRate), 1.5, 'rate');
    await t.page.evaluate(() => {
      window.__fsCalled = false;
      document.querySelector('.video-container').requestFullscreen = () => {
        window.__fsCalled = true;
        return Promise.resolve();
      };
    });
    await t.page.locator('.vc-fullscreen').click();
    t.assert(await t.page.evaluate(() => window.__fsCalled), 'fullscreen request path');
  }),
  j('G-player-quality', 'Published quality and persistence', async (t) => {
    await t.goto('/posts/single-video/');
    await play(t);
    await t.page.locator('.vc-quality-btn').click();
    await waitFor(async () => (await t.page.locator('.vc-quality-menu button').count()) >= 3, {
      message: 'quality choices',
    });
    const labels = await t.page.locator('.vc-quality-menu button').allTextContents();
    t.note(`quality labels: ${JSON.stringify(labels)}`);
    t.assert(labels.some((x) => x.includes('240p')) && labels.some((x) => x.includes('480p')), 'both published tiers');
    t.assert(!labels.some((x) => /720p|1080p|4K/.test(x)), 'no unpublished tiers');
    for (const tier of ['480p', '240p']) {
      const v = t.page.locator('video').first();
      // The synthetic clip is only six seconds long. Give each switch its own
      // playback window so browser scheduling cannot turn natural EOF into a
      // quality-switch failure.
      await v.evaluate(async (x) => {
        x.currentTime = 1;
        x.playbackRate = 0.5;
        await x.play();
      });
      await t.page.locator('.vc-quality-menu button').filter({ hasText: tier }).click();
      const before = await v.evaluate((x) => x.currentTime);
      await waitFor(() => v.evaluate((x, b) => !x.paused && x.currentTime > b + 0.2, before), {
        timeout: 8000,
        message: 'continues after quality',
      });
      if (tier === '480p') await t.page.locator('.vc-quality-btn').click();
    }
    t.assertEqual(await t.page.evaluate(() => localStorage.getItem('mosaic_video_quality')), '240p', 'quality saved');
    await t.page.reload();
    await play(t);
    t.assertEqual(
      await t.page.evaluate(() => localStorage.getItem('mosaic_video_quality')),
      '240p',
      'quality retained',
    );
  }),
  j('G-player-seek-resume', 'Seek and resume', async (t) => {
    await t.goto('/posts/single-video/');
    await play(t);
    const v = t.page.locator('video').first();
    await v.evaluate((x) => {
      x.currentTime = 2.5;
    });
    await waitFor(() => v.evaluate((x) => x.currentTime >= 2.5 && !x.paused), { message: 'seek continues' });
    await v.evaluate((x) => x.pause());
    const saved = await t.page.evaluate(() =>
      Object.entries(localStorage).filter(([k]) => k.startsWith('mosaic_video_pos_')),
    );
    t.note(`saved positions ${JSON.stringify(saved)}`);
    t.assert(
      saved.some(([, v]) => Number(v) >= 2),
      'position saved',
    );
    await t.page.reload();
    await play(t);
    await waitFor(() => v.evaluate((x) => x.currentTime >= 1.5), { message: 'restored position' });
  }),
  j('G-player-playlist', 'Playlist selection and auto advance', async (t) => {
    await t.goto('/posts/playlist-deep/');
    t.assertEqual(await t.page.locator('.pl-item').count(), 3, 'three items');
    await t.page.locator('.pl-item').nth(1).click();
    t.assert(
      await t.page
        .locator('.pl-item')
        .nth(1)
        .evaluate((e) => e.classList.contains('active')),
      'second active',
    );
    await play(t);
    const v = t.page.locator('video:visible').first();
    await v.evaluate((x) => {
      x.currentTime = x.duration - 0.15;
    });
    await waitFor(
      () =>
        t.page
          .locator('.pl-item')
          .nth(2)
          .evaluate((e) => e.classList.contains('active')),
      { timeout: 10000, message: 'advance to third' },
    );
    await t.sleep(800);
    t.assert(
      await t.page
        .locator('.pl-item')
        .nth(2)
        .evaluate((e) => e.classList.contains('active')),
      'advance once',
    );
    t.assert(
      (await t.page.locator('video').evaluateAll((vs) => vs.filter((v) => !v.paused).length)) <= 1,
      'one video playing',
    );
  }),
  j('G-player-native', 'Native MP4 playback', async (t) => {
    await t.goto('/posts/native-video/');
    await play(t);
    await waitFor(
      () =>
        t.page
          .locator('video')
          .first()
          .evaluate((v) => v.currentTime > 0.2),
      { message: 'MP4 advances' },
    );
    t.note('WebKit blocked: runner provides Chromium only');
  }),
  j('G-player-broken', 'Broken HLS fallback or error', async (t) => {
    const missing = [];
    t.page.on('response', (r) => {
      if (r.url().includes('/missing/master.m3u8')) missing.push(r.status());
    });
    await t.goto('/posts/broken-video/');
    await t.page.locator('.video-big-play').first().click();
    await waitFor(
      async () =>
        (await t.page
          .locator('video')
          .first()
          .evaluate((v) => v.readyState >= 3)) || (await t.page.locator('.video-error.show').count()),
      { timeout: 20000, message: 'fallback or visible error' },
    );
    t.assert(missing.includes(404), 'fixture HLS genuinely returns 404');
    t.note(
      `Broken HLS outcome: ${
        (await t.page
          .locator('video')
          .first()
          .evaluate((v) => v.readyState >= 3))
          ? 'MP4 fallback ready'
          : 'visible error'
      }`,
    );
    await t.page.reload();
    await t.page.locator('.video-big-play').first().click();
    await waitFor(
      async () =>
        (await t.page
          .locator('video')
          .first()
          .evaluate((v) => v.readyState >= 3)) || (await t.page.locator('.video-error.show').count()),
      { timeout: 20000, message: 'recovery after reload' },
    );
  }),
];
