import { defineJourney } from '../lib/journey.mjs';
import { mockPublicApi } from '../lib/browser.mjs';
export const area = 'perf';
const j = (id, title, steps, opts = {}) =>
  defineJourney({
    id,
    title,
    priority: 'P1',
    assertNoErrors: false,
    ...opts,
    steps: async (t) => {
      await mockPublicApi(t.page);
      await steps(t);
    },
  });
async function posts(t) {
  return (await t.page.request.get(`${t.base}/data/posts-index.json`)).json();
}
async function observe(t) {
  await t.page.addInitScript(() => {
    window.__perf = { lcp: 0, cls: 0, longtasks: [] };
    for (const type of ['largest-contentful-paint', 'layout-shift', 'longtask'])
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (type === 'largest-contentful-paint') window.__perf.lcp = e.startTime;
            if (type === 'layout-shift' && !e.hadRecentInput) window.__perf.cls += e.value;
            if (type === 'longtask') window.__perf.longtasks.push(e.duration);
          }
        }).observe({ type, buffered: true });
      } catch {}
  });
}
async function metrics(t) {
  await t.page.waitForTimeout(2500);
  return t.page.evaluate(() => ({
    ...window.__perf,
    resources: performance.getEntriesByType('resource').reduce((a, e) => {
      const k = e.initiatorType;
      a[k] ||= { count: 0, bytes: 0 };
      a[k].count++;
      a[k].bytes += e.transferSize;
      return a;
    }, {}),
    origins: [...new Set(performance.getEntriesByType('resource').map((e) => new URL(e.name).origin))],
  }));
}
export const journeys = [
  j('G-01', 'Home core web vitals and origins', async (t) => {
    await observe(t);
    await t.goto('/');
    const m = await metrics(t);
    t.note(JSON.stringify(m));
    const bad = m.origins.filter(
      (o) => o !== new URL(t.base).origin && !/^https:\/\/mosaic-(media|api)\.xsanye\.cn$/.test(o),
    );
    t.assert(
      m.lcp > 0 && m.lcp < 2500 && m.cls < 0.1 && !bad.length,
      `budgets/origins: ${JSON.stringify({ lcp: m.lcp, cls: m.cls, bad })}`,
    );
  }),
  j('G-02', 'Gallery metrics, image sizes and preconnect', async (t) => {
    const p = (await posts(t)).find((p) => p.media?.gallery?.length);
    t.assert(p, 'gallery fixture required');
    await observe(t);
    await t.goto(`/posts/${p.slug}/`);
    const m = await metrics(t);
    const imgs = await t.page.evaluate(() => ({
      images: [...document.images].map((i) => ({
        src: i.currentSrc,
        natural: i.naturalWidth,
        display: i.getBoundingClientRect().width,
        complete: i.complete,
      })),
      preconnect: [...document.querySelectorAll('link[rel="preconnect"]')].map((e) => e.href),
    }));
    t.note(JSON.stringify({ route: p.slug, ...m, ...imgs }));
    const oversized = imgs.images.filter((i) => i.complete && i.natural > 1440 * 2);
    t.assert(
      m.lcp > 0 && m.lcp < 2500 && m.cls < 0.1 && imgs.preconnect.length && !oversized.length,
      `gallery budget/preconnect/oversized: ${JSON.stringify({ lcp: m.lcp, cls: m.cls, preconnect: imgs.preconnect, oversized })}`,
    );
  }),
  j('G-03', 'Video requests are intent gated', async (t) => {
    const p = (await posts(t)).find((p) => p.media?.videos?.length);
    t.assert(p, 'video fixture required');
    const requests = [];
    t.page.on('request', (r) => {
      if (/\.(m3u8|ts)(\?|$)/i.test(r.url())) requests.push({ url: r.url(), time: Date.now() });
    });
    await t.goto(`/posts/${p.slug}/`);
    await t.page.waitForTimeout(1500);
    const before = requests.length;
    const click = Date.now();
    await t.page.locator('.video-big-play').first().click();
    await t.page.waitForTimeout(3000);
    t.note(JSON.stringify({ route: p.slug, before, requests: requests.map((r) => ({ ...r, delay: r.time - click })) }));
    t.assert(
      before === 0 && requests.some((r) => /\.ts(\?|$)/i.test(r.url) && r.time - click <= 3000),
      'no HLS before click; first segment within 3 seconds',
    );
  }),
  j(
    'G-04',
    'Production cache and encoding headers',
    async (t) => {
      const ps = await posts(t);
      const p = ps.find((x) => x.media?.gallery?.length);
      const urls = [
        'https://mosaic.xsanye.cn/',
        `https://mosaic.xsanye.cn/posts/${p.slug}/`,
        'https://mosaic.xsanye.cn/assets/css/bundle.css',
        p.cover,
      ].filter(Boolean);
      for (const url of urls) {
        try {
          const r = await t.page.request.get(url, { timeout: 12000 });
          t.note(
            JSON.stringify({
              url,
              status: r.status(),
              cacheControl: r.headers()['cache-control'] || '',
              contentEncoding: r.headers()['content-encoding'] || '',
            }),
          );
        } catch (e) {
          t.note(JSON.stringify({ url, error: String(e) }));
        }
      }
    },
    { timeoutMs: 60000 },
  ),
  j('G-05', 'SEO metadata, feed and sitemap', async (t) => {
    const ps = await posts(t);
    const p = ps.find((x) => x.media?.gallery?.length);
    const problems = [];
    for (const url of ['/', `/posts/${p.slug}/`]) {
      await t.goto(url);
      const m = await t.page.evaluate(() => ({
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content,
        ogImage: document.querySelector('meta[property="og:image"]')?.content,
        canonical: document.querySelector('link[rel="canonical"]')?.href,
      }));
      t.note(`${url} ${JSON.stringify(m)}`);
      for (const [k, v] of Object.entries(m)) if (!v) problems.push(`${url} missing ${k}`);
    }
    const data = {};
    for (const url of ['/robots.txt', '/feed.xml', '/sitemap.xml']) {
      const r = await t.page.request.get(t.base + url);
      data[url] = { status: r.status(), body: await r.text() };
      if (!r.ok()) problems.push(`${url} HTTP ${r.status()}`);
    }
    const parsed = await t.page.evaluate((data) => {
      const parser = new DOMParser();
      const feed = parser.parseFromString(data['/feed.xml'].body, 'application/xml');
      const sitemap = parser.parseFromString(data['/sitemap.xml'].body, 'application/xml');
      return {
        feedErrors: feed.querySelectorAll('parsererror').length,
        items: feed.querySelectorAll('item,entry').length,
        sitemapErrors: sitemap.querySelectorAll('parsererror').length,
        urls: [...sitemap.querySelectorAll('url > loc')].map((e) => e.textContent),
      };
    }, data);
    const missing = ps
      .filter((p) => !parsed.urls.some((u) => new URL(u).pathname === `/posts/${p.slug}/`))
      .map((p) => p.slug);
    t.note(
      JSON.stringify({
        robotsStatus: data['/robots.txt'].status,
        feedStatus: data['/feed.xml'].status,
        sitemapStatus: data['/sitemap.xml'].status,
        indexCount: ps.length,
        ...parsed,
        missing,
      }),
    );
    if (parsed.feedErrors || parsed.sitemapErrors || parsed.items !== ps.length || missing.length)
      problems.push(
        `feed/sitemap mismatch ${JSON.stringify({ feedErrors: parsed.feedErrors, sitemapErrors: parsed.sitemapErrors, items: parsed.items, index: ps.length, missing })}`,
      );
    t.assert(!problems.length, problems.join('; '));
  }),
];
