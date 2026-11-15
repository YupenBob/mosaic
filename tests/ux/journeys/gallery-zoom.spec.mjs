import { defineJourney, waitFor } from '../lib/journey.mjs';

export const area = 'gallery';
export const targets = ['fixtures'];
const img = '#gallery-current-img';
const thumbs = '.gallery-item img, .gallery-single-item img';
async function open(t, index = 0) {
  // The shared JPEG is only 96×64: it stays smaller than the viewer at the tested zoom levels.
  // Use a realistic photo size so pan/anchor assertions exercise overflow.
  await t.page.route('**/fixture/photo.jpg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="steelblue"/></svg>',
    }),
  );
  await t.goto('/posts/gallery-deep/');
  await t.page.locator(thumbs).nth(index).click();
  await waitFor(async () => (await t.page.locator('#gallery-counter').innerText()) === `${index + 1} / 4`, {
    message: 'viewer counter',
  });
  await waitFor(() => t.page.locator(img).evaluate((e) => e.complete && e.naturalWidth > 0), {
    message: 'viewer image loaded',
  });
}
async function matrix(page) {
  return page.locator(img).evaluate((e) => {
    const m = new DOMMatrix(getComputedStyle(e).transform);
    const r = e.getBoundingClientRect();
    return { scale: m.a, x: m.e, y: m.f, left: r.left, top: r.top, width: r.width, height: r.height };
  });
}
async function zoom(page) {
  const r = await page.locator(img).boundingBox();
  await page.mouse.move(r.x + r.width * 0.65, r.y + r.height * 0.55);
  await page.mouse.wheel(0, -100);
  await waitFor(async () => (await matrix(page)).scale > 1, { message: 'wheel zoom' });
}
const journey = (id, title, steps, extra = {}) => defineJourney({ id, title, priority: 'P1', steps, ...extra });
export const journeys = [
  journey(
    'GZ-01',
    'Open clicked image and navigate with buttons and arrows',
    async (t) => {
      await open(t, 1);
      t.assertEqual(
        await t.page.locator('.filmstrip-thumb.active').getAttribute('data-index'),
        '1',
        'clicked image active',
      );
      await t.page.locator('#gallery-next').click();
      await waitFor(async () => (await t.page.locator('#gallery-counter').innerText()) === '3 / 4');
      await t.page.locator('#gallery-prev').click();
      await waitFor(async () => (await t.page.locator('#gallery-counter').innerText()) === '2 / 4');
      await t.page.keyboard.press('ArrowRight');
      await waitFor(async () => (await t.page.locator('#gallery-counter').innerText()) === '3 / 4');
      await t.page.keyboard.press('ArrowLeft');
      await waitFor(async () => (await t.page.locator('#gallery-counter').innerText()) === '2 / 4');
      t.note(
        'Synthetic photos share a URL and have no caption metadata; active filmstrip index verifies selection. Viewer has no caption element.',
      );
      await t.shot('navigation');
      await t.page.keyboard.press('Escape');
      t.assert(
        !(await t.page.locator('#gallery-overlay').evaluate((e) => e.classList.contains('open'))),
        'Escape closes viewer',
      );
    },
    { priority: 'P0' },
  ),
  journey('GZ-02', 'Focus enters viewer and returns to the opening thumbnail', async (t) => {
    await open(t, 1);
    for (let i = 0; i < 40; i++) {
      await t.page.keyboard.press(i < 20 ? 'Tab' : 'Shift+Tab');
      t.assert(
        await t.page.evaluate(() => document.querySelector('#gallery-overlay').contains(document.activeElement)),
        'focus cycles inside viewer',
      );
    }
    t.assert(
      await t.page.evaluate(() => document.querySelector('#gallery-overlay').contains(document.activeElement)),
      'Tab focus stays in viewer',
    );
    await t.page.keyboard.press('Escape');
    t.assert(
      await t.page
        .locator(thumbs)
        .nth(1)
        .evaluate((e) => document.activeElement === e || e.contains(document.activeElement)),
      'focus returns to opening thumbnail',
    );
  }),
  journey('GZ-11', 'Escape returns focus to the opening thumbnail', async (t) => {
    await open(t, 1);
    await t.page.keyboard.press('Escape');
    t.assert(
      !(await t.page.locator('#gallery-overlay').evaluate((e) => e.classList.contains('open'))),
      'Escape closes',
    );
    t.assert(
      await t.page
        .locator(thumbs)
        .nth(1)
        .evaluate((e) => document.activeElement === e || e.contains(document.activeElement)),
      'focus returns to opening thumbnail',
    );
  }),
  journey('GZ-12', 'Keyboard zero resets wheel zoom', async (t) => {
    await open(t);
    await zoom(t.page);
    await t.page.keyboard.press('0');
    t.assert(Math.abs((await matrix(t.page)).scale - 1) < 0.001, '0 resets zoom');
  }),
  journey('GZ-03', 'Wheel zoom anchors to cursor and reverses; double click toggles', async (t) => {
    await open(t);
    const before = await matrix(t.page);
    const x = before.left + before.width * 0.65,
      y = before.top + before.height * 0.55;
    await t.page.mouse.move(x, y);
    await t.page.mouse.wheel(0, -100);
    await waitFor(async () => (await matrix(t.page)).scale > 1);
    const after = await matrix(t.page);
    t.assert(
      Math.abs((x - before.left) / before.width - (x - after.left) / after.width) < 0.01 &&
        Math.abs((y - before.top) / before.height - (y - after.top) / after.height) < 0.01,
      'cursor anchor remains on image point',
    );
    t.assert(after.width > before.width && after.height > before.height, 'zoom changes bounds');
    await t.page.mouse.wheel(0, 100);
    await waitFor(async () => Math.abs((await matrix(t.page)).scale - 1) < 0.001);
    await t.page.locator(img).dblclick();
    t.assert((await matrix(t.page)).scale > 1, 'double click zooms in');
    await t.page.locator(img).dblclick();
    t.assert(Math.abs((await matrix(t.page)).scale - 1) < 0.001, 'double click resets');
    await t.shot('zoom');
  }),
  journey('GZ-04', 'Drag pans and clamps at image edges', async (t) => {
    await open(t);
    await zoom(t.page);
    const b = await t.page.locator(img).boundingBox();
    await t.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await t.page.mouse.down();
    await t.page.mouse.move(1400, 850, { steps: 5 });
    await t.page.mouse.up();
    const m = await matrix(t.page);
    await t.shot('drag');
    t.assert(Math.abs(m.x) > 5 || Math.abs(m.y) > 5, 'drag moves image');
    t.assert(
      m.left <= 1440 && m.left + m.width >= 0 && m.top <= 810 && m.top + m.height >= 48,
      `image remains in viewer bounds: ${JSON.stringify(m)}`,
    );
    // At this scale, dragging farther must not continue moving the image.
    const start = await t.page.locator(img).boundingBox();
    await t.page.mouse.move(Math.min(1400, start.x + start.width / 2), Math.min(800, start.y + start.height / 2));
    await t.page.mouse.down();
    await t.page.mouse.move(1435, 895, { steps: 5 });
    await t.page.mouse.up();
    const end = await matrix(t.page);
    t.assert(
      Math.abs(end.x) <= Math.max(0, (end.width - 1440) / 2) + 2 &&
        Math.abs(end.y) <= Math.max(0, (end.height - 762) / 2) + 2,
      `pan clamped to edges: ${JSON.stringify(end)}`,
    );
  }),
  journey('GZ-05', 'Keyboard zoom and reset', async (t) => {
    await open(t);
    await t.page.keyboard.press('+');
    t.assert((await matrix(t.page)).scale > 1, '+ zooms in');
    await t.page.keyboard.press('-');
    await t.page.keyboard.press('0');
    t.assert(Math.abs((await matrix(t.page)).scale - 1) < 0.001, '0 resets fit');
    await t.page.keyboard.press('Escape');
    t.assert(
      !(await t.page.locator('#gallery-overlay').evaluate((e) => e.classList.contains('open'))),
      'Escape closes',
    );
  }),
  journey('GZ-06', 'Navigation resets per-image zoom and Escape closes zoomed viewer', async (t) => {
    await open(t);
    await zoom(t.page);
    await t.page.locator('#gallery-next').click();
    await waitFor(async () => (await t.page.locator('#gallery-counter').innerText()) === '2 / 4');
    t.assert(Math.abs((await matrix(t.page)).scale - 1) < 0.001, 'next image resets zoom');
    await t.page.locator('#gallery-prev').click();
    await waitFor(async () => (await t.page.locator('#gallery-counter').innerText()) === '1 / 4');
    t.assert(Math.abs((await matrix(t.page)).scale - 1) < 0.001, 'returning image remains reset');
    t.note('updateImage resets zoom on every navigation; zoom is not per-image persistent.');
    await zoom(t.page);
    await t.page.keyboard.press('Escape');
    t.assert(
      !(await t.page.locator('#gallery-overlay').evaluate((e) => e.classList.contains('open'))),
      'Escape closes while zoomed',
    );
  }),
  journey('GZ-07', 'Fit/fill retains current image', async (t) => {
    await open(t, 2);
    const src = await t.page.locator(img).getAttribute('src');
    await t.page.locator('#gallery-fit').click();
    t.assert(await t.page.locator(img).evaluate((e) => e.classList.contains('fill')), 'fill class applied');
    t.assertEqual(await t.page.locator('#gallery-counter').innerText(), '3 / 4', 'counter unchanged');
    t.assertEqual(await t.page.locator(img).getAttribute('src'), src, 'image unchanged');
    await t.page.locator('#gallery-fit').click();
    t.assert(!(await t.page.locator(img).evaluate((e) => e.classList.contains('fill'))), 'fit restored');
  }),
  journey(
    'GZ-08',
    'Mobile pinch zoom and touch pan',
    async (t) => {
      await open(t);
      const cdp = await t.context.newCDPSession(t.page);
      const touch = (type, points) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
      await touch('touchStart', [
        [150, 400],
        [240, 400],
      ]);
      await touch('touchMove', [
        [100, 400],
        [290, 400],
      ]);
      await touch('touchEnd', []);
      await waitFor(async () => (await matrix(t.page)).scale > 1, { message: 'CDP pinch zoom' });
      const before = await matrix(t.page);
      await touch('touchStart', [[190, 400]]);
      await touch('touchMove', [[250, 450]]);
      await touch('touchEnd', []);
      const after = await matrix(t.page);
      await t.shot('touch-pan');
      t.assert(
        await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'no horizontal overflow',
      );
      t.assert(
        Math.abs(after.x - before.x) > 5 || Math.abs(after.y - before.y) > 5,
        `one-finger pan changes transform: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
      );
      t.assert(
        await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'no horizontal overflow',
      );
    },
    { viewport: 'mobile' },
  ),
  journey('GZ-09', 'Broken photo shows a fallback and navigation survives', async (t) => {
    await t.page.route('**/fixture/photo.jpg', (route) => route.abort());
    await t.goto('/posts/gallery-deep/');
    await t.page.locator(thumbs).first().click();
    await waitFor(async () => (await t.page.locator('#gallery-counter').innerText()) === '1 / 4');
    await waitFor(() => t.page.locator(img).evaluate((e) => e.complete && e.currentSrc && e.naturalWidth === 0), {
      message: 'blocked image failed',
    });
    await t.page.locator('#gallery-next').click();
    await waitFor(async () => (await t.page.locator('#gallery-counter').innerText()) === '2 / 4');
    await t.shot('broken');
    t.assert(
      await t.page
        .locator(
          '#gallery-overlay [role="alert"], #gallery-overlay .gallery-error, #gallery-overlay .gallery-placeholder',
        )
        .first()
        .isVisible(),
      'visible error or placeholder for failed photo',
    );
  }),
  journey('GZ-10', 'Mixed post viewer leaves video and music usable', async (t) => {
    await t.goto('/posts/mixed-deep/');
    await t.page.locator(thumbs).first().click();
    await waitFor(() => t.page.locator('#gallery-overlay').evaluate((e) => e.classList.contains('open')));
    await t.page.locator('#gallery-done').click();
    t.assert(
      !(await t.page.locator('#gallery-overlay').evaluate((e) => e.classList.contains('open'))),
      'viewer closed',
    );
    await t.page.locator('.video-big-play').first().click();
    await waitFor(
      () =>
        t.page
          .locator('video')
          .first()
          .evaluate((e) => !e.paused),
      { message: 'video plays' },
    );
    await t.page.locator('.music-track').first().click();
    await waitFor(
      () =>
        t.page
          .locator('.music-track')
          .first()
          .evaluate((e) => e.classList.contains('playing')),
      { message: 'music starts' },
    );
    await t.shot('mixed');
  }),
];
