/**
 * Worker smoke tests — runs the Hono app in plain Node with mocked R2/GitHub.
 *
 * Usage: node tests/worker-smoke.mjs
 * Covers: login + rate limiting, fail-closed config, track/stats/dwell,
 *         config deep merge, media delete, taxonomy rename, upload limits.
 */
import assert from 'node:assert/strict';
import app from '../worker/src/index.js';
import { StatsDurableObject } from '../worker/src/stats-do.js';
import { clientIp } from '../worker/src/auth.js';

// ── Mock R2 ──
const store = new Map();
const media = {
  get: async (key) => {
    if (!store.has(key)) return null;
    return { text: async () => store.get(key), httpMetadata: { contentType: 'application/json' }, httpEtag: 'etag1' };
  },
  head: async (key) => (store.has(key) ? { size: store.get(key).length || 1 } : null),
  put: async (key, value) => { store.set(key, typeof value === 'string' ? value : String(value)); },
  delete: async (key) => { store.delete(key); },
  list: async ({ prefix = '' } = {}) => {
    const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: store.get(key).length || 1 }));
    return { objects, truncated: false, cursor: null };
  },
};

// ── Mock Stats Durable Object (shared instance => serialized writes) ──
const statsStore = new Map();
const statsState = {
  storage: {
    get: async (k) => (statsStore.has(k) ? statsStore.get(k) : null),
    put: async (k, v) => { statsStore.set(k, v); },
  },
};
const statsDO = new StatsDurableObject(statsState, { MEDIA: media });
const STATS = {
  idFromName: () => 'global',
  get: () => ({ fetch: (url, init) => statsDO.fetch(new Request(url, init)) }),
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
    R2_ACCESS_KEY: 'test-access-key',
    R2_SECRET_KEY: 'test-secret-key',
    CF_ACCOUNT_ID: 'test-account',
    STATS,
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

// ── 5b. Concurrent views are serialized by the Durable Object ──
await record('concurrent views serialized (10/10 counted)', async () => {
  await Promise.all([...Array(10)].map((_, i) =>
    call('/api/track/view/race-post', { method: 'POST', headers: { 'CF-Connecting-IP': `10.1.0.${i}` } })
  ));
  const r = await (await call('/api/stats/race-post')).json();
  assert.equal(r.views, 10);
});

// ── 6. Config deep merge ──
await record('listPosts reads R2 posts cache (when not dirty)', async () => {
  await media.put('site-data/posts.json', JSON.stringify([{ slug: 'cached', title: 'Cached Post' }]));
  const r = await call('/api/posts', { token: TOKEN });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.total, 1);
  assert.equal(d.posts[0].slug, 'cached');
  store.delete('site-data/posts.json');
});

// ── 7. Config deep merge ──
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

// ── 9b. Presigned direct upload flow ──
await record('presign URL + complete (direct-to-R2 flow)', async () => {
  const pr = await call('/api/upload/presign', {
    method: 'POST', token: TOKEN,
    body: { slug: 'a', filename: 'clip.mp4', contentType: 'video/mp4' },
  });
  assert.equal(pr.status, 200);
  const p = await pr.json();
  assert.ok(p.url.includes('X-Amz-Signature'), 'presigned URL carries SigV4 signature');
  assert.equal(p.key, 'originals/a/videos/clip.mp4');
  assert.equal(p.folder, 'videos');
  // Complete for a missing object -> 404
  const missing = await call('/api/upload/complete/a/missing.mp4', { method: 'POST', token: TOKEN });
  assert.equal(missing.status, 404);
  // Upload object (simulated) then complete -> 200 + dirty marked
  await media.put('originals/a/videos/clip.mp4', 'x');
  const done = await call('/api/upload/complete/a/clip.mp4', { method: 'POST', token: TOKEN });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).size, 1);
  const dirty = await (await call('/api/dirty', { token: TOKEN })).json();
  assert.ok((dirty.count || 0) >= 1, 'dirty marked after complete');
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

// ── 11. HMAC client IP verification ──
const signHmac = async (secret, message) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const hmacIp = (headers) => {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return clientIp({
    env: { PROXY_SECRET: 'proxy-secret-1' },
    req: { header: (n) => lower[n.toLowerCase()] || '' },
  });
};

await record('HMAC client IP (valid signature passes)', async () => {
  const bucket = Math.floor(Date.now() / 60000);
  const ip = '203.0.113.7';
  const sig = await signHmac('proxy-secret-1', `${ip}:${bucket}`);
  assert.equal(await hmacIp({
    'X-Mosaic-Proxy-IP': ip,
    'X-Mosaic-Proxy-Time': String(bucket),
    'X-Mosaic-Proxy-Sig': sig,
  }), ip);
});

await record('HMAC client IP (forged signature rejected)', async () => {
  const bucket = Math.floor(Date.now() / 60000);
  const sig = await signHmac('wrong-secret', `203.0.113.7:${bucket}`);
  const got = await hmacIp({
    'X-Mosaic-Proxy-IP': '203.0.113.7',
    'X-Mosaic-Proxy-Time': String(bucket),
    'X-Mosaic-Proxy-Sig': sig,
    'CF-Connecting-IP': '198.51.100.9',
  });
  assert.equal(got, '198.51.100.9');
});

await record('HMAC client IP (expired window rejected)', async () => {
  const oldBucket = Math.floor(Date.now() / 60000) - 10;
  const ip = '203.0.113.7';
  const sig = await signHmac('proxy-secret-1', `${ip}:${oldBucket}`);
  const got = await hmacIp({
    'X-Mosaic-Proxy-IP': ip,
    'X-Mosaic-Proxy-Time': String(oldBucket),
    'X-Mosaic-Proxy-Sig': sig,
    'CF-Connecting-IP': '198.51.100.10',
  });
  assert.equal(got, '198.51.100.10');
});

await record('HMAC client IP (legacy static header accepted)', async () => {
  const got = await hmacIp({
    'X-Mosaic-Proxy': 'proxy-secret-1',
    'X-Real-IP': '203.0.113.8',
  });
  assert.equal(got, '203.0.113.8');
});

// ── 12. CORS allowlist ──
await record('CORS allowlist (admin allowed, others blocked, public open)', async () => {
  const allowed = await call('/api/config', { token: TOKEN, headers: { Origin: 'https://mosaic-admin.xsanye.cn' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://mosaic-admin.xsanye.cn');
  const blocked = await call('/api/config', { token: TOKEN, headers: { Origin: 'https://evil.example' } });
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  const custom = await call('/api/config', {
    token: TOKEN,
    headers: { Origin: 'https://admin2.example' },
    bindings: env({ ALLOWED_ORIGINS: 'https://admin2.example' }),
  });
  assert.equal(custom.headers.get('access-control-allow-origin'), 'https://admin2.example');
  const pub = await call('/api/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(pub.headers.get('access-control-allow-origin'), '*');
});

// ── 13. Usage snapshot ──
await record('usage snapshot (disk rebuilds, uploads/deletes adjust)', async () => {
  // First disk read lists the bucket and persists the snapshot baseline.
  const disk = await (await call('/api/disk', { token: TOKEN })).json();
  assert.ok(disk.size >= 1 && disk.objects >= 1, 'disk lists bucket');
  assert.ok(store.has('site-data/media-usage.json'), 'snapshot persisted by disk read');
  const base = JSON.parse(store.get('site-data/media-usage.json'));

  // Upload a new object via the presigned-complete path → snapshot grows.
  await media.put('originals/a/photos/new.jpg', 'yy');
  const done = await call('/api/upload/complete/a/new.jpg', { method: 'POST', token: TOKEN });
  assert.equal(done.status, 200);
  const afterUpload = JSON.parse(store.get('site-data/media-usage.json'));
  assert.equal(afterUpload.objects, base.objects + 1, 'object count increased after upload');
  assert.ok(afterUpload.size >= base.size, 'size increased after upload');

  // deleteMediaFile → snapshot shrinks.
  await call('/api/media/a/new.jpg', { method: 'DELETE', token: TOKEN });
  const afterDelete = JSON.parse(store.get('site-data/media-usage.json'));
  assert.ok(afterDelete.objects <= afterUpload.objects, 'object count decreased after delete');
  assert.ok(afterDelete.size <= afterUpload.size, 'size decreased after delete');
});

globalThis.fetch = realFetch;
console.log(results.map((r) => `  ${r}`).join('\n'));
console.log(`\nWorker smoke: ${passed} groups passed`);
if (passed < 19) process.exit(1);
