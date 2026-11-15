import { defineJourney } from '../lib/journey.mjs';
export const area = 'seo';
const site = 'https://mosaic.xsanye.cn';
const j = (id, title, steps) => defineJourney({ id, title, priority: 'P1', timeoutMs: 90000, steps });
async function guard(t) {
  await t.page.route('**/*', (r) => (/^(GET|HEAD|OPTIONS)$/.test(r.request().method()) ? r.continue() : r.abort()));
}
async function index(t) {
  return (await t.page.request.get(t.base + '/data/posts-index.json')).json();
}
export const journeys = [
  j('G-801', 'Strict XML, post URL and robots semantics', async (t) => {
    await guard(t);
    const posts = await index(t);
    const docs = {};
    for (const path of ['/feed.xml', '/sitemap.xml', '/robots.txt']) {
      const r = await t.page.request.get(t.base + path);
      docs[path] = await r.text();
      t.assertEqual(r.status(), 200, path);
    }
    const v = await t.page.evaluate((d) => {
      const p = new DOMParser(),
        f = p.parseFromString(d['/feed.xml'], 'application/xml'),
        s = p.parseFromString(d['/sitemap.xml'], 'application/xml');
      return {
        errors: [...f.querySelectorAll('parsererror'), ...s.querySelectorAll('parsererror')].map((x) => x.textContent),
        xmlns: s.documentElement.namespaceURI,
        feed: ['title', 'link', 'description', 'item'].map((x) => !!f.querySelector(x)),
        items: [...f.querySelectorAll('item link')].map((x) => x.textContent),
        urls: [...s.getElementsByTagNameNS('*', 'loc')].map((x) => x.textContent),
      };
    }, docs);
    t.note(JSON.stringify(v));
    t.note('robots: ' + docs['/robots.txt']);
    t.assert(!v.errors.length, 'XML parse errors');
    t.assert(v.xmlns === 'http://www.sitemaps.org/schemas/sitemap/0.9', 'sitemap namespace');
    t.assert(v.feed.every(Boolean), 'feed required elements');
    for (const u of v.urls) t.assert(/^https?:\/\//.test(u), 'absolute loc ' + u);
    for (const post of posts) {
      const path = '/posts/' + post.slug + '/';
      t.assert(
        v.urls.some((u) => new URL(u).pathname === path),
        'sitemap missing ' + path,
      );
      t.assert(
        v.items.some((u) => new URL(u).pathname === path),
        'feed missing ' + path,
      );
    }
    t.assert(
      v.urls.some((u) => new URL(u).pathname.startsWith('/categories/')) &&
        v.urls.some((u) => new URL(u).pathname.startsWith('/tags/')),
      'taxonomy sitemap URLs',
    );
    t.assert(/user-agent\s*:/i.test(docs['/robots.txt']), 'robots user agent');
    if (/site-data/i.test(docs['/robots.txt']))
      t.assert(/(?:allow|disallow)\s*:\s*\/site-data/i.test(docs['/robots.txt']), 'site-data robots directive');
  }),
  j('G-802', 'Head completeness across page types', async (t) => {
    await guard(t);
    const posts = await index(t);
    const post = posts.find((x) => x.tags?.length) || posts[0];
    const routes = [
      '/',
      '/posts/' + post.slug + '/',
      '/categories/' + encodeURIComponent(post.category) + '/',
      '/tags/' + encodeURIComponent(post.tags?.[0] || 'missing') + '/',
      '/404.html',
    ];
    const problems = [];
    for (const route of routes) {
      await t.goto(route);
      const m = await t.page.evaluate(() => ({
        title: document.title,
        description: document.querySelector('meta[name=description]')?.content,
        canon: [...document.querySelectorAll('link[rel=canonical]')].map((x) => x.href),
        h1: document.querySelectorAll('h1').length,
        og: Object.fromEntries(
          ['title', 'description', 'url', 'image'].map((k) => [
            k,
            document.querySelector(`meta[property="og:${k}"]`)?.content,
          ]),
        ),
        twitter: document.querySelector('meta[name="twitter:card"]')?.content,
        json: [...document.querySelectorAll('script[type="application/ld+json"]')].map((x) => {
          try {
            return JSON.parse(x.textContent);
          } catch {
            return null;
          }
        }),
      }));
      t.note(route + ' ' + JSON.stringify(m));
      const is404 = route === '/404.html';
      const expected = site + (is404 ? '/404.html' : route);
      const noindex = await t.page.evaluate(() => document.querySelector('meta[name=robots]')?.content || '');
      const decode = (u) => {
        try {
          return decodeURIComponent(u);
        } catch {
          return u;
        }
      };
      const ok = is404
        ? !m.title ||
          !m.description ||
          m.h1 !== 1 ||
          !m.og.title ||
          !m.og.description ||
          !m.og.image ||
          !m.twitter ||
          !/noindex/i.test(noindex)
        : !m.title ||
          !m.description ||
          m.canon.length !== 1 ||
          decode(m.canon[0]) !== decode(expected) ||
          m.h1 !== 1 ||
          ![m.og.title, m.og.description, m.og.image].every(Boolean) ||
          decode(m.og.url || '').replace(/\/$/, '') !== decode(expected).replace(/\/$/, '') ||
          !m.twitter ||
          !m.json.length ||
          m.json.some((x) => !x || !x['@type']);
      if (ok) problems.push(route);
    }
    t.assert(!problems.length, 'incomplete head: ' + problems.join(', '));
  }),
  j('G-803', 'Production cache headers and local performance', async (t) => {
    await guard(t);
    const posts = await index(t);
    await t.page.addInitScript(() => {
      window.__qaPerf = { cls: 0, lcp: 0 };
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__qaPerf.cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__qaPerf.lcp = e.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    const perfProblems = [];
    const requests = new Set();
    t.page.on('request', (r) => requests.add(new URL(r.url()).origin));
    for (const route of ['/', '/posts/' + posts[0].slug + '/']) {
      await t.goto(route);
      await t.sleep(2500);
      const p = await t.page.evaluate(() => window.__qaPerf);
      t.note(route + ' perf ' + JSON.stringify(p));
      if (!(p.lcp > 0 && p.lcp < 2500 && p.cls < 0.1)) perfProblems.push(route + ' performance budget');
    }
    t.note('request origins ' + JSON.stringify([...requests]));
    const allowed = [
      new URL(t.base).origin,
      'https://mosaic-media.xsanye.cn',
      'https://mosaic-api.xsanye.cn',
      'https://busuanzi.ibruce.info',
      'http://busuanzi.ibruce.info',
      'https://busuanzi.9420.ltd',
    ];
    t.assert(
      [...requests].every((x) => allowed.includes(x)),
      'unexpected third-party origin',
    );
    const home = await (await t.page.request.get(site + '/')).text();
    const js = home.match(/(?:src=["'])([^"']*assets\/js\/app\.[^"']+\.js)/)?.[1];
    const urls = [
      site + '/',
      site + '/posts/' + posts[0].slug + '/',
      site + '/categories/' + encodeURIComponent(posts[0].category) + '/',
      site + '/assets/css/bundle.css',
      js && new URL(js, site).href,
      posts.find((x) => x.cover)?.cover,
      'https://mosaic-media.xsanye.cn/processed/assets/ast_ejhd4etd8pryr909xj8gxzgjkd/legacy/2020P112P62Nice-master.m3u8?mosaic-cors=cors-v1',
    ].filter(Boolean);
    const cacheProblems = [];
    for (const url of urls) {
      try {
        const r = await t.page.request.get(url, { timeout: 12000 });
        const h = r.headers();
        t.note(
          JSON.stringify({
            url,
            status: r.status(),
            ...Object.fromEntries(
              ['content-type', 'cache-control', 'content-encoding', 'vary', 'age'].map((k) => [k, h[k] || '']),
            ),
          }),
        );
        const cc = h['cache-control'] || '';
        if (/\.js(\?|$)/.test(url)) {
          if (!/immutable/i.test(cc)) cacheProblems.push(url + ' lacks immutable');
        } else if (/\.css(\?|$)/.test(url)) {
          // Un-hashed CSS: immutable would pin a stale bundle after a deploy.
          const max = Number(cc.match(/(?:s-maxage|max-age)=(\d+)/i)?.[1] || 0);
          if (max < 3600) cacheProblems.push(url + ' CSS cache shorter than 1h');
        } else if (url.startsWith(site)) {
          const max = Number(cc.match(/(?:s-maxage|max-age)=(\d+)/i)?.[1] || 0);
          if (max > 86400) cacheProblems.push(url + ' HTML cached over one day');
        }
      } catch (e) {
        if (String(e).includes('lacks immutable') || String(e).includes('cached over')) throw e;
        t.note('fetch error ' + url + ' ' + e);
      }
    }
    t.assert(!cacheProblems.length && !perfProblems.length, [...perfProblems, ...cacheProblems].join('; '));
  }),
  j('G-804', 'Image sizing, alt text and lazy loading', async (t) => {
    await guard(t);
    const posts = await index(t);
    const p = posts.find((x) => x.media?.gallery?.length) || posts[0];
    let problems = [];
    for (const route of ['/', '/posts/' + p.slug + '/']) {
      await t.goto(route);
      await t.sleep(1500);
      const imgs = await t.page.locator('img').evaluateAll((es) =>
        es.map((e) => ({
          src: e.currentSrc,
          alt: e.hasAttribute('alt'),
          w: e.getAttribute('width'),
          h: e.getAttribute('height'),
          ratio: getComputedStyle(e).aspectRatio,
          parentRatio: getComputedStyle(e.parentElement).aspectRatio,
          display: e.getBoundingClientRect().width,
          top: e.getBoundingClientRect().top,
          natural: e.naturalWidth,
          loading: e.loading,
          cover: !!e.closest('.post-card, .related-card'),
        })),
      );
      t.note(route + ' ' + JSON.stringify(imgs));
      for (const i of imgs) {
        if (i.display === 0) continue;
        if (
          !i.alt ||
          (!(i.w && i.h) && i.ratio === 'auto' && i.parentRatio === 'auto') ||
          (i.top > 900 && i.loading !== 'lazy') ||
          (!i.cover && !i.src.endsWith('.svg') && i.natural > 2 * i.display && i.display > 0)
        )
          problems.push({ route, ...i });
      }
    }
    t.assert(!problems.length, 'image audit ' + JSON.stringify(problems));
  }),
];
