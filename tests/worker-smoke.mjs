/**
 * Worker smoke tests — runs the Hono app in plain Node with mocked R2/GitHub.
 *
 * Usage: node tests/worker-smoke.mjs
 * Covers: login + rate limiting, fail-closed config, track/stats/dwell,
 *         config deep merge, media delete, taxonomy rename, upload limits.
 */
import assert from 'node:assert/strict';
import app from '../worker/src/index.js';

// ── Mock R2 ──
const store = new Map();
const media = {
  get: async (key) => {
    if (!store.has(key)) return null;
    return { text: async () => store.get(key), httpMetadata: { contentType: 'application/json' }, httpEtag: 'etag1' };
  },
  put: async (key, value) => { store.set(key, typeof value === 'string' ? value : String(value)); },
  delete: async (key) => { store.delete(key); },
  list: async ({ prefix = '' } = {}) => {
    const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: store.get(key).length || 1 }));
    return { objects, truncated: false, cursor: null };
  },
};

// ── Mock GitHub contents API ──
const gh = new Map([
  ['mosaic.config.json', JSON.stringify({
    title: 'Mosaic', url: 'https://example.com',
    imageQuality: { '480p': 75 },
    components: { gallery: { enabled: true }, video: { enabled: true } },
    plugins: { 'generate-feed': { enabled: true }, 'generate-sitemap': { enabled: true } },
  }, null, 2)],
  ['content/posts/a/index.md', '---\ntitle: A\ncategory: photo\ntags: [x, y]\n---\n\nbody'],
]);

const ghFetch = async (url, opts = {}) => {
  const prefix = 'https://api.github.com/repos/test/repo/contents/';
  const href = String(url);
  if (!href.startsWith(prefix)) return new Response(JSON.stringify({}), { status: 404 });
  const key = decodeURIComponent(href.slice(prefix.length)).replace(/\/+$/, '');
  if (key === 'content/posts') {
    const names = [...gh.keys()].filter((k) => k.startsWith('content/posts/')).map((k) => k.split('/')[2]);
    return new Response(JSON.stringify([...new Set(names)].map((name) => ({ type: 'dir', name }))), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (opts.method === 'PUT') {
    const body = JSON.parse(opts.body);
    gh.set(key, Buffer.from(body.content, 'base64').toString('utf8'));
    return new Response(JSON.stringify({ content: { sha: body.sha || 'new' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  const val = gh.get(key);
  if (!val) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  return new Response(JSON.stringify({ content: Buffer.from(val, 'utf8').toString('base64'), sha: 'sha1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const realFetch = globalThis.fetch;
globalThis.fetch = ghFetch;

function env(overrides = {}) {
  return {
    MEDIA: media,
    ADMIN_PASSWORD: 'admin123',
    JWT_SECRET: 's'.repeat(64),
    GITHUB_REPO: 'test/repo',
    GITHUB_TOKEN: 'ghp_test',
    DEV_MODE: 'false',
    R2_PUBLIC_URL: '',
    R2_BUCKET: 'mosaic-media',
    ...overrides,
  };
}

async function call(path, { method = 'GET', body, token, headers = {}, bindings = env() } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['Authorization'] = `Bearer ${token}`;
  return app.request(path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }, bindings);
}

let passed = 0;
const results = [];
async function record(name, fn) {
  try { await fn(); passed++; results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}

// ── 1. Health (public) ──
await record('GET /api/health', async () => {
  const r = await call('/api/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');
});

// ── 2. Login: wrong password → 401, correct → token ──
let TOKEN = '';
await record('login (401 wrong / 200 correct + token)', async () => {
  const bad = await call('/api/auth/login', { method: 'POST', body: { password: 'nope' } });
  assert.equal(bad.status, 401);
  const ok = await call('/api/auth/login', { method: 'POST', body: { password: 'admin123' } });
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.ok(data.token);
  TOKEN = data.token;
});

// ── 3. Fail-closed: missing JWT_SECRET → 503 ──
await record('fail-closed (503 without JWT_SECRET)', async () => {
  const noSecret = env({ JWT_SECRET: '' });
  const r = await call('/api/auth/login', { method: 'POST', body: { password: 'admin123' }, bindings: noSecret });
  assert.equal(r.status, 503);
  const cfg = await call('/api/config', { token: 'x', bindings: noSecret });
  assert.equal(cfg.status, 503);
});

// ── 4. Protected route without token → 401 ──
await record('protected route requires token (401)', async () => {
  const r = await call('/api/config');
  assert.equal(r.status, 401);
});

// ── 5. Track view + dwell + stats (public, R2 mock) ──
await record('track/dwell/stats (+7200 cap)', async () => {
  await call('/api/track/view/test-post', { method: 'POST' });
  await call('/api/track/dwell/test-post', { method: 'POST', body: { seconds: 123 } });
  const r = await call('/api/stats/test-post');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.views, 1);
  assert.equal(d.dwell_time, 123);
  await call('/api/track/dwell/test-post', { method: 'POST', body: { seconds: 99999 } });
  const d2 = await (await call('/api/stats/test-post')).json();
  assert.equal(d2.dwell_time, 7200);
});

// ── 6. Config deep merge ──
await record('config deep merge (nested fields preserved)', async () => {
  const r = await call('/api/config', { method: 'PUT', token: TOKEN, body: { components: { gallery: { enabled: false } } } });
  assert.equal(r.status, 200);
  const cfg = await (await call('/api/config', { token: TOKEN })).json();
  assert.equal(cfg.components.gallery.enabled, false);
  assert.equal(cfg.components.video.enabled, true);
  assert.ok(cfg.plugins['generate-feed']);
  assert.ok(cfg.imageQuality['480p']);
});

// ── 7. Media delete (originals + processed) ──
await record('media delete (both prefixes, keeps others)', async () => {
  store.set('originals/a/photos/p1.jpg', 'x');
  store.set('processed/a/photos/p1.jpg', 'x');
  store.set('processed/a/photos/p2.jpg', 'x');
  const r = await call('/api/media/a/p1.jpg', { method: 'DELETE', token: TOKEN });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.deleted, 2);
  assert.ok(!store.has('originals/a/photos/p1.jpg'));
  assert.ok(!store.has('processed/a/photos/p1.jpg'));
  assert.ok(store.has('processed/a/photos/p2.jpg'));
});

// ── 8. Taxonomy rename (category + tag) ──
await record('taxonomy rename (category + tag)', async () => {
  const rc = await call('/api/taxonomy/category', { method: 'PUT', token: TOKEN, body: { oldName: 'photo', newName: 'photography' } });
  assert.equal((await rc.json()).renamed, 1);
  assert.ok(gh.get('content/posts/a/index.md').includes('category: photography'));
  const rt = await call('/api/taxonomy/tag', { method: 'PUT', token: TOKEN, body: { oldName: 'x', newName: 'z' } });
  assert.equal((await rt.json()).renamed, 1);
  assert.ok(gh.get('content/posts/a/index.md').includes('tags: [z, y]'));
});

// ── 9. Upload limits + auth + site-data namespace ──
await record('upload auth/size-limit/site-data namespace', async () => {
  const noToken = await call('/api/upload/direct/a/x.jpg', { method: 'POST' });
  assert.equal(noToken.status, 401);
  const tooBig = await call('/api/upload/direct/a/x.jpg', { method: 'POST', token: TOKEN, headers: { 'Content-Length': String(3 * 1024 * 1024 * 1024) }, body: '{}' });
  assert.equal(tooBig.status, 413);
  const ok = await call('/api/upload/direct/a/x.jpg', { method: 'POST', token: TOKEN, headers: { 'Content-Length': '5' }, body: 'abcde' });
  assert.equal(ok.status, 200);
  assert.ok(store.has('originals/a/photos/x.jpg'));
  const favicon = await call('/api/upload/direct/site-data/favicon.svg', { method: 'POST', token: TOKEN, headers: { 'Content-Length': '3' }, body: '<svg/>' });
  assert.equal(favicon.status, 200);
  assert.ok(store.has('site-data/favicon.svg'));
});

// ── 10. Login rate limiting ──
await record('login rate limit (429 after 5 failures)', async () => {
  const h = { 'CF-Connecting-IP': '10.0.0.9' };
  let last = 0;
  for (let i = 0; i < 6; i++) {
    const r = await call('/api/auth/login', { method: 'POST', body: { password: 'wrong' }, headers: h });
    last = r.status;
  }
  assert.equal(last, 429);
});

globalThis.fetch = realFetch;
console.log(results.map((r) => `  ${r}`).join('\n'));
console.log(`\nWorker smoke: ${passed}/10 groups passed`);
if (passed < 10) process.exit(1);
