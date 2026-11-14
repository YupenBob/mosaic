import { defineJourney } from '../lib/journey.mjs';
import { mockPublicApi } from '../lib/browser.mjs';
export const area = 'edge';
export const targets = ['local'];
const j = (id, title, steps) =>
  defineJourney({
    id,
    title,
    priority: 'P1',
    timeoutMs: 65000,
    steps: async (t) => {
      await mockPublicApi(t.page);
      await steps(t);
    },
  });
const observe = async (t) => {
  await t.page.waitForTimeout(1200);
  const x = await t.page.evaluate(() => ({
    cards: document.querySelectorAll('a.post-card').length,
    body: document.body.innerText.slice(0, 400),
    loading: [...document.querySelectorAll('[class*=loading],[class*=spinner]')].filter(
      (e) => e.offsetWidth && e.offsetHeight,
    ).length,
  }));
  t.note(JSON.stringify(x));
  t.assert(x.body.trim().length > 10, 'visible page content');
  return x;
};
const fail =
  (status, body = '') =>
  (route) =>
    route.fulfill({
      status,
      body,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
const api = (id, path, handler) =>
  j(id, `API ${path} fault and recovery`, async (t) => {
    let hits = 0;
    const h = async (r) => {
      hits++;
      await handler(r);
    };
    await t.page.route(`**/api/${path}/**`, h);
    await t.goto('/posts/text-only/');
    await observe(t);
    t.assert(hits > 0, 'fault route intercepted after mock');
    t.note(`fault hits=${hits}; like text=${await t.page.locator('.like-button').first().innerText()}`);
    if (path === 'track') {
      await t.page.locator('.like-button').click();
      await t.page.waitForTimeout(500);
    }
    await t.page.unroute(`**/api/${path}/**`, h);
    await t.goto('/posts/text-only/');
    await observe(t);
  });
const data = (id, status, body) =>
  j(id, `Index ${status} ${body.slice(0, 12)} failure`, async (t) => {
    let hits = 0;
    await t.page.route('**/data/posts-index.json*', (r) => {
      hits++;
      return fail(status, body)(r);
    });
    await t.goto('/');
    await observe(t);
    t.note(`index fault hits=${hits}`);
    t.assert(hits > 0, 'index request intercepted');
    const input = t.page.locator('.search-input');
    await input.fill('zzzz');
    await t.page.waitForTimeout(700);
    await observe(t);
  });
export const journeys = [
  api('E-01', 'stats', fail(500, '{}')),
  api('E-02', 'track', fail(500, '{}')),
  api('E-03', 'track', fail(429, '{}')),
  api('E-04', 'stats', (r) => r.abort('timedout')),
  data('E-05', 500, '{}'),
  data('E-06', 200, ''),
  data('E-07', 200, '{bad'),
  j('E-08', 'Broken card images preserve layout', async (t) => {
    await t.page.route(/\.(png|jpe?g|webp|avif)(\?.*)?$/i, (r) => r.abort());
    await t.goto('/');
    await observe(t);
    const c = t.page.locator('a.post-card').first();
    const box = await c.boundingBox();
    const img = c.locator('img').first();
    t.note(
      `card=${JSON.stringify(box)} img=${JSON.stringify(await img.evaluate((e) => ({ alt: e.alt, complete: e.complete, naturalWidth: e.naturalWidth, src: e.currentSrc.slice(0, 100) })))}`,
    );
    t.assert(box.height > 100, 'card has height');
  }),
  j('E-09', 'Video manifest and segment failures', async (t) => {
    let hits = 0;
    await t.page.route(/\.(m3u8|ts)(\?.*)?$/i, (r) => {
      hits++;
      return r.abort();
    });
    await t.goto('/posts/my-post/');
    await t.page.locator('.video-big-play').first().click();
    await t.page.waitForTimeout(8000);
    t.note(
      `blocked HLS=${hits}; errors=${await t.page.locator('.video-error').allTextContents()}; video=${JSON.stringify(
        await t.page
          .locator('video')
          .first()
          .evaluate((v) => ({ ready: v.readyState, paused: v.paused, error: v.error?.code })),
      )}`,
    );
    await t.shot('fault');
    await t.page.unrouteAll({ behavior: 'wait' });
    await mockPublicApi(t.page);
    await t.page.reload();
    await observe(t);
    t.assert((await t.page.locator('.video-big-play').count()) > 0, 'controls available after reload');
  }),
  j('E-10', 'Offline after loading and reconnect', async (t) => {
    await t.goto('/');
    await observe(t);
    await t.context.setOffline(true);
    await t.page.locator('.search-input').fill('zzzz');
    await t.page.locator('#theme-menu-toggle').click();
    await t.page.waitForTimeout(1000);
    await observe(t);
    await t.context.setOffline(false);
    await t.page.reload();
    await observe(t);
  }),
  j('E-11', 'Offline from start', async (t) => {
    await t.context.setOffline(true);
    try {
      await t.goto('/');
      await observe(t);
    } catch (e) {
      t.note(`navigation error=${e.message.split('\n')[0]}`);
      t.assert(false, 'offline initial navigation unavailable');
    } finally {
      await t.context.setOffline(false);
    }
  }),
  j('E-12', 'Rapid theme, note and like interactions', async (t) => {
    await t.goto('/');
    for (let i = 0; i < 10; i++) await t.page.locator('#theme-menu-toggle').click();
    t.note(`theme menu expanded=${await t.page.locator('#theme-menu-toggle').getAttribute('aria-expanded')}`);
    for (let i = 0; i < 5; i++) {
      await t.page.locator('a.post-card').first().click();
      await t.page.locator('dialog.note-modal[open]').waitFor();
      await t.page.keyboard.press('Escape');
      await t.page.locator('dialog.note-modal[open]').waitFor({ state: 'hidden' });
    }
    await t.goto('/posts/text-only/');
    const like = t.page.locator('.like-button');
    for (let i = 0; i < 25; i++) await like.click();
    await t.page.waitForTimeout(1000);
    t.note(`like text=${await like.innerText()} class=${await like.getAttribute('class')}`);
    t.assert(!/-\d/.test(await like.innerText()), 'nonnegative count');
  }),
  j('E-13', 'Unknown and malformed deep links', async (t) => {
    for (const path of [
      '/?note=unknown-qa',
      '/posts/unknown-qa/',
      '/categories/unknown-qa/',
      '/posts/%ZZ/',
      '/posts/%3Cscript%3E/',
    ]) {
      try {
        const r = await t.goto(path);
        await t.page.waitForTimeout(300);
        t.note(
          `${path} status=${r?.status()} title=${await t.page.title()} text=${(await t.page.locator('body').innerText()).slice(0, 120)}`,
        );
      } catch (e) {
        t.note(`${path} navigation failed: ${e.message.split('\n')[0]}`);
      }
    }
  }),
  j('E-14', 'XSS query, note and hash probes', async (t) => {
    let dialogs = 0;
    t.page.on('dialog', (d) => {
      dialogs++;
      d.dismiss();
    });
    for (const path of [
      '/?q=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
      '/?note=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      '/#%3Csvg%20onload%3Dalert(1)%3E',
    ]) {
      await t.goto('/');
      await t.goto(path);
      await t.page.waitForTimeout(800);
      t.note(
        `${path} reflected=${await t.page.evaluate(() => !!document.body && (document.body.innerHTML.includes('onerror=alert(1)') || document.body.innerHTML.includes('<script>alert(1)</script>')))}`,
      );
    }
    t.assertEqual(dialogs, 0, 'no alert dialogs');
  }),
  j('E-15', 'History and scroll across search category and post', async (t) => {
    await t.goto('/');
    await t.page.locator('.search-input').fill('zzzz');
    await t.page.waitForTimeout(600);
    await t.page.locator('.search-input').fill('');
    await t.page.locator('a[href^="categories/"]').first().click();
    await t.page.locator('a.post-card').first().click();
    await t.page.locator('.note-open-post').click();
    t.note(`post=${t.page.url()}`);
    for (let i = 0; i < 3; i++) {
      await t.page.goBack();
      await t.page.waitForTimeout(500);
      t.note(`back${i + 1}=${t.page.url()} scroll=${await t.page.evaluate(() => scrollY)}`);
    }
    await t.page.goForward();
    t.note(`forward=${t.page.url()}`);
  }),
  j('E-16', 'Keyboard escape and tab during modal animation', async (t) => {
    await t.goto('/');
    await t.page.locator('a.post-card').first().click();
    for (let i = 0; i < 8; i++) {
      await t.page.keyboard.press('Tab');
      await t.page.keyboard.press('Escape');
    }
    await observe(t);
    t.note(`open dialogs=${await t.page.locator('dialog[open]').count()}`);
  }),
  j('E-17', 'Slow data and HTML failure', async (t) => {
    let hits = 0;
    await t.page.route('**/data/posts-index.json*', async (r) => {
      hits++;
      await new Promise((s) => setTimeout(s, 3000));
      await r.continue();
    });
    await t.goto('/');
    await observe(t);
    await t.page.waitForTimeout(3500);
    t.note(`slow index hits=${hits}`);
    await t.page.route(t.base + '/', (r) =>
      r.fulfill({ status: 500, contentType: 'text/html', body: 'Server unavailable' }),
    );
    const response = await t.goto('/');
    t.note(`document failure status=${response.status()} body=${await t.page.locator('body').innerText()}`);
  }),
];
