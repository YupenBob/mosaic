import { defineJourney } from '../lib/journey.mjs';
export const area = 'edge';
export const targets = ['prod'];
const api = 'https://mosaic-api.xsanye.cn';
const j = (id, title, steps) => defineJourney({ id, title, priority: 'P1', timeoutMs: 60000, steps });
const record = async (t, label, r) => {
  const body = await r.text();
  t.note(
    `${label}: status=${r.status()} content-type=${r.headers()['content-type']} ACAO=${r.headers()['access-control-allow-origin'] || '<none>'} body=${body.slice(0, 500)}`,
  );
  t.assert(!/\bat\s+\w+\s*\([^\n]+:\d+:\d+\)|Traceback \(most recent/i.test(body), `${label} no stack trace`);
  return r.status();
};
export const journeys = [
  j('E-18', 'Production API validation', async (t) => {
    const p = t.page.request;
    let r = await p.post(api + '/api/track/view/qa-unknown-round4', { data: {} });
    const status = await record(t, 'unknown view POST', r);
    await record(t, 'unknown stats', await p.get(api + '/api/stats/qa-unknown-round4'));
    await record(t, 'encoded traversal stats', await p.get(api + '/api/stats/..%2F..%2Fqa'));
    await record(
      t,
      'oversize view POST',
      await p.post(api + '/api/track/view/qa-unknown-round4', {
        data: 'x'.repeat(2048),
        headers: { 'content-type': 'application/json' },
      }),
    );
    t.assert([400, 404].includes(status), 'unknown view returns 400 or 404');
  }),
  j('E-19', 'Production headers and data exposure', async (t) => {
    const p = t.page.request;
    await record(t, 'health', await p.get(api + '/api/health'));
    for (const origin of ['https://mosaic.xsanye.cn', 'https://mosaic-admin.xsanye.cn', 'https://evil.com'])
      await record(
        t,
        `preflight ${origin}`,
        await p.fetch(api + '/api/stats/qa-unknown-round4', {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'GET' },
        }),
      );
    for (const path of ['/data/posts.json', '/data/posts-index.json', '/site-data/', '/site-data/posts.json'])
      await record(t, path, await p.get(t.base + path));
  }),
  j('E-20', 'Production missing routes and 404 document', async (t) => {
    for (const path of [
      '/posts/qa-unknown-round4/',
      '/categories/qa-unknown-round4/',
      '/qa-unknown-round4/',
      '/404.html',
    ]) {
      const r = await t.page.goto(t.base + path, { waitUntil: 'domcontentloaded' });
      t.note(
        `${path}: status=${r.status()} final=${t.page.url()} title=${await t.page.title()} text=${(await t.page.locator('body').innerText()).slice(0, 200)}`,
      );
    }
  }),
];
