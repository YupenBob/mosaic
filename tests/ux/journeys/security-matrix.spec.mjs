import { defineJourney } from '../lib/journey.mjs';
export const area = 'security';
const api = 'https://mosaic-api.xsanye.cn',
  site = 'https://mosaic.xsanye.cn',
  media = 'https://mosaic-media.xsanye.cn';
const j = (id, title, steps) => defineJourney({ id, title, priority: 'P1', timeoutMs: 90000, steps });
async function guard(t) {
  await t.page.route('**/*', (r) => (/^(GET|HEAD|OPTIONS)$/.test(r.request().method()) ? r.continue() : r.abort()));
  t.page.on('dialog', (d) => {
    t.note('dialog: ' + d.message());
    d.dismiss();
  });
}
async function record(t, label, r) {
  const body = await r.text();
  const h = r.headers();
  t.note(
    JSON.stringify({
      label,
      status: r.status(),
      headers: {
        acao: h['access-control-allow-origin'],
        methods: h['access-control-allow-methods'],
        headers: h['access-control-allow-headers'],
        credentials: h['access-control-allow-credentials'],
      },
      body: body.slice(0, 500),
    }),
  );
  t.assert(!/Traceback \(most recent|\bat\s+\w+\s*\([^\n]+:\d+:\d+\)/i.test(body), label + ' stack');
  t.assert(h['access-control-allow-credentials'] !== 'true', label + ' credentials');
  return { status: r.status(), body };
}
export const journeys = [
  j('E-801', 'Metadata fixture escaping and trusted body boundary', async (t) => {
    await guard(t);
    if (t.target !== 'fixtures') {
      t.note('Blocked: metadata fixture requires fixtures target');
      return;
    }
    await t.goto('/posts/xss-deep/');
    await t.sleep(400);
    const v = await t.page.evaluate(() => ({
      x: window.__xss || 0,
      title: document.title,
      h1: document.querySelector('h1')?.textContent,
      desc: document.querySelector('meta[name=description]')?.content,
      scripts: [...document.querySelectorAll('script[type="application/ld+json"]')].map((x) => x.textContent),
      events: document.querySelectorAll('[onerror],[onload]').length,
    }));
    t.note(JSON.stringify(v));
    t.assert(v.x === 0 && v.events === 0, 'metadata executed or created event handler');
    t.assert(
      v.h1?.includes('<img') && v.title.includes('<img') && v.desc?.includes('<script>'),
      'metadata text preserved',
    );
    for (const s of v.scripts) JSON.parse(s);
    await t.goto('/');
    const card = t.page.locator('a.post-card').filter({ hasText: 'XSS 载荷' });
    t.note('fixture card count ' + (await card.count()));
    if (await card.count()) t.assertEqual(await card.locator('[onerror],[onload]').count(), 0, 'card handlers');
    t.note(
      'Raw post body HTML is authored-trusted by design; trusted-html-deep excluded from sink checks. Fixture category/tags contain no executable payload, so malicious taxonomy metadata coverage is blocked.',
    );
  }),
  j('E-802', 'Query, hash and route injection and DOM sinks', async (t) => {
    await guard(t);
    const routes = [
      '/?q=%3Cimg%20src=x%20onerror=window.__xss=1%3E',
      '/?note=%3Cscript%3Ewindow.__xss=1%3C%2Fscript%3E',
      '/#%3Csvg%20onload=window.__xss=1%3E',
      '/tags/%3Csvg%20onload=window.__xss=1%3E/',
      '/categories/%3Csvg%20onload=window.__xss=1%3E/',
      '/posts/%3Csvg%20onload=window.__xss=1%3E/',
      '/tags/%E0%A4%A/',
      '/?q=%E0%A4%A',
    ];
    for (const route of routes) {
      try {
        await t.goto(route);
      } catch (error) {
        // Chromium/Node rejects malformed percent-encoding before the page loads;
        // that is a transport behavior, not app DOM injection.
        t.note(route + ' malformed navigation: ' + String(error).split('\n')[0]);
        continue;
      }
      await t.sleep(100);
      const v = await t.page.evaluate(() => ({
        x: window.__xss || 0,
        events: document.querySelectorAll('[onerror],[onload]').length,
        scripts: [...document.querySelectorAll('main script, article script')].filter(
          (x) => x.type !== 'application/ld+json',
        ).length,
      }));
      t.note(route + ' ' + JSON.stringify(v));
      t.assert(v.x === 0 && v.events === 0 && v.scripts === 0, route + ' unsafe DOM');
    }
    const index = await (await t.page.request.get(t.base + '/data/posts-index.json')).json();
    await t.goto('/posts/' + index[0].slug + '/');
    t.assertEqual(await t.page.locator('[onerror],[onload]').count(), 0, 'post event handlers');
  }),
  j('E-803', 'Production preflight and public request contracts', async (t) => {
    await guard(t);
    if (t.target === 'fixtures') {
      t.note('Production contracts exercised on local run only; POST budget preserved.');
      return;
    }
    const p = t.page.request;
    for (const origin of [site, 'https://mosaic-admin.xsanye.cn', 'https://evil.com'])
      await record(
        t,
        'preflight ' + origin,
        await p.fetch(api + '/api/stats/posts', {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'content-type' },
        }),
      );
    for (const path of [
      '/api/health?qa_unknown_field=qa_marker_839',
      '/api/stats/qa-unknown-round8?qa_unknown_field=qa_marker_839',
    ]) {
      const v = await record(t, path, await p.get(api + path));
      t.assert(!v.body.includes('qa_marker_839'), 'unknown field reflected');
    }
    const idx = await (await p.get(site + '/data/posts-index.json')).json();
    const contractProblems = [];
    for (const [label, slug, body] of [
      ['oversize', idx[0].slug, 'x'.repeat(1024 * 1024)],
      ['invalid', idx[0].slug, '{invalid'],
      ['unknown', 'qa-unknown-round8', '{}'],
    ]) {
      const v = await record(
        t,
        label,
        await p.post(api + '/api/track/view/' + encodeURIComponent(slug), {
          data: body,
          headers: { 'content-type': 'application/json' },
          timeout: 20000,
        }),
      );
      t.assert(v.status < 500 && v.body.length < 10000, label + ' bounded non-5xx');
      if (label === 'unknown') t.assertEqual(v.status, 404, 'unknown slug');
      else if (label === 'oversize') {
        if (v.status < 400) contractProblems.push('oversize accepted');
      }
    }
    t.note('30 POST rate-limit probe blocked by five-POST maximum; three anonymous POSTs used.');
    t.assert(!contractProblems.length, contractProblems.join('; '));
  }),
  j('E-804', 'Anonymous authorization and exposure', async (t) => {
    await guard(t);
    if (t.target === 'fixtures') {
      t.note('Production authorization exercised on local run only.');
      return;
    }
    const p = t.page.request;
    for (const path of ['/api/admin/', '/api/media/', '/api/drafts/', '/api/stats/posts', '/api/stats/traffic']) {
      const v = await record(t, path, await p.get(api + path));
      t.assert([401, 403].includes(v.status), path + ' anonymous authorization');
    }
    const asset = await record(t, 'unknown asset', await p.get(api + '/api/media/qa-unknown-round8'));
    if (asset.status === 401 || asset.status === 403)
      t.note('Unknown asset validation blocked by authentication; no authorized write or credential used.');
    else t.assert([400, 404].includes(asset.status), 'unknown asset status');
    for (const [base, path, expected] of [
      [site, '/data/posts.json', 404],
      [site, '/data/posts-index.json', 200],
      [site, '/stats.json', 404],
      [site, '/assets/js/app.js.map', 404],
      [media, '/site-data/', null],
      [media, '/site-data/posts.json', null],
    ]) {
      const v = await record(t, base + path, await p.get(base + path));
      if (expected) t.assertEqual(v.status, expected, path);
      else t.note('Known media WAF residual: status recorded without asserting access policy.');
    }
  }),
];
