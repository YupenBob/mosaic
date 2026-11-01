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
import { bustCache } from '../worker/src/github.js';

// ── Mock R2 ──
const store = new Map();
const media = {
  get: async (key) => {
    if (!store.has(key)) return null;
    return { text: async () => store.get(key), httpMetadata: { contentType: 'application/json' }, httpEtag: 'etag1' };
  },
  head: async (key) => (store.has(key) ? { size: store.get(key).length || 1 } : null),
  put: async (key, value) => {
    store.set(key, typeof value === 'string' ? value : String(value));
  },
  delete: async (key) => {
    store.delete(key);
  },
  list: async ({ prefix = '' } = {}) => {
    const objects = [...store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key, size: store.get(key).length || 1 }));
    return { objects, truncated: false, cursor: null };
  },
};

// ── Mock Stats Durable Object (shared instance => serialized writes) ──
const statsStore = new Map();
const statsState = {
  storage: {
    get: async (k) => (statsStore.has(k) ? statsStore.get(k) : null),
    put: async (k, v) => {
      statsStore.set(k, v);
    },
  },
};
const statsDO = new StatsDurableObject(statsState, { MEDIA: media });
const STATS = {
  idFromName: () => 'global',
  get: () => ({ fetch: (url, init) => statsDO.fetch(new Request(url, init)) }),
};

// ── Mock GitHub contents API ──
const gh = new Map([
  [
    'mosaic.config.json',
    JSON.stringify(
      {
        title: 'Mosaic',
        url: 'https://example.com',
        imageQuality: { '480p': 75 },
        components: { gallery: { enabled: true }, video: { enabled: true } },
        plugins: { 'generate-feed': { enabled: true }, 'generate-sitemap': { enabled: true } },
      },
      null,
      2,
    ),
  ],
  ['content/posts/a/index.md', '---\ntitle: A\ncategory: photo\ntags: [x, y]\n---\n\nbody'],
]);

let mockRunStatus = 'in_progress';
let mockGithubDown = false;
let lastDispatchBody = null;
let mpSeq = 0;
const mpUploads = new Set();
const mpAborted = new Set();
const ghFetch = async (url, opts = {}) => {
  const prefix = 'https://api.github.com/repos/test/repo/contents/';
  const href = typeof url === 'string' ? url : String(url?.url || url);
  const method = (opts?.method || url?.method || 'GET').toUpperCase();
  if (href.includes('.r2.cloudflarestorage.com')) {
    const u = new URL(href);
    if (u.searchParams.get('uploads') !== null) {
      const id = `test-mp-${++mpSeq}`;
      mpUploads.add(id);
      return new Response(
        `<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        { status: 200, headers: { 'Content-Type': 'application/xml' } },
      );
    }
    const uploadId = u.searchParams.get('uploadId');
    if (uploadId) {
      if (mpAborted.has(uploadId)) {
        return new Response('<?xml version="1.0"?><Error><Code>NoSuchUpload</Code></Error>', {
          status: 404,
          headers: { 'Content-Type': 'application/xml' },
        });
      }
      if (method === 'DELETE') {
        mpAborted.add(uploadId);
        return new Response(null, { status: 204 });
      }
      return new Response(
        '<?xml version="1.0"?><ListPartsResult><Bucket>b</Bucket><Key>k</Key><UploadId>' +
          uploadId +
          '</UploadId><IsTruncated>false</IsTruncated></ListPartsResult>',
        { status: 200, headers: { 'Content-Type': 'application/xml' } },
      );
    }
    return new Response('<?xml version="1.0"?><Error><Code>NoSuchUpload</Code></Error>', {
      status: 404,
      headers: { 'Content-Type': 'application/xml' },
    });
  }
  if (href.includes('/rate_limit')) {
    return new Response(
      JSON.stringify(mockGithubDown ? { message: 'down' } : { resources: { core: { limit: 5000, remaining: 4999 } } }),
      { status: mockGithubDown ? 500 : 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (href.includes('/actions/workflows/pipeline.yml/dispatches')) {
    lastDispatchBody = JSON.parse(opts.body || '{}');
    return new Response(null, { status: 204 });
  }
  if (href.includes('/actions/workflows/pipeline.yml/runs')) {
    return new Response(
      JSON.stringify({
        workflow_runs: [
          {
            id: 123,
            run_number: 7,
            status: mockRunStatus,
            conclusion: null,
            display_title: 'smoke',
            head_branch: 'main',
            head_sha: 'abc1234',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            event: 'workflow_dispatch',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (href.includes('/actions/runs/') && href.endsWith('/cancel')) {
    return new Response(null, { status: 202 });
  }
  const runMatch = href.match(/\/actions\/runs\/(\d+)$/);
  if (runMatch) {
    const id = Number(runMatch[1]);
    if (id !== 123) {
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const completed = mockRunStatus === 'completed';
    return new Response(
      JSON.stringify({
        id: 123,
        run_number: 7,
        status: mockRunStatus,
        conclusion: completed ? 'failure' : null,
        display_title: 'smoke',
        head_branch: 'main',
        head_sha: 'abc1234',
        head_commit: { message: 'smoke commit' },
        html_url: 'https://github.com/test/repo/actions/runs/123',
        created_at: new Date(Date.now() - 60000).toISOString(),
        updated_at: new Date().toISOString(),
        event: 'workflow_dispatch',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (/\/actions\/runs\/123\/jobs$/.test(href)) {
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 60000).toISOString();
    return new Response(
      JSON.stringify({
        jobs: [
          {
            html_url: 'https://github.com/test/repo/actions/runs/123/job/1',
            steps: [
              {
                name: 'Checkout',
                status: 'completed',
                conclusion: 'success',
                number: 1,
                started_at: past,
                completed_at: now,
              },
              {
                name: 'Deploy to Cloudflare Pages',
                status: 'completed',
                conclusion: 'failure',
                number: 2,
                started_at: past,
                completed_at: now,
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (!href.startsWith(prefix)) return new Response(JSON.stringify({}), { status: 404 });
  const key = decodeURIComponent(href.slice(prefix.length)).replace(/\/+$/, '');
  if (key === 'content/posts') {
    const names = [...gh.keys()].filter((k) => k.startsWith('content/posts/')).map((k) => k.split('/')[2]);
    return new Response(JSON.stringify([...new Set(names)].map((name) => ({ type: 'dir', name }))), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (opts.method === 'PUT') {
    const body = JSON.parse(opts.body);
    gh.set(key, Buffer.from(body.content, 'base64').toString('utf8'));
    return new Response(JSON.stringify({ content: { sha: body.sha || 'new' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const val = gh.get(key);
  if (!val) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  return new Response(JSON.stringify({ content: Buffer.from(val, 'utf8').toString('base64'), sha: 'sha1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
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
    ALLOWED_ORIGINS: 'https://mosaic-admin.xsanye.cn',
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
  return app.request(
    path,
    {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    },
    bindings,
  );
}

let passed = 0;
const results = [];
async function record(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`PASS ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
  }
}

// ── 1. Health (public) ──
await record('GET /api/health', async () => {
  const r = await call('/api/health');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.version, '1.0.0');
});

await record('GET /api/health/github (real probe, up/down)', async () => {
  const ok = await (await call('/api/health/github')).json();
  assert.equal(ok.status, 'ok');
  assert.equal(ok.httpStatus, 200);
  assert.ok(Number.isFinite(ok.latency));
  mockGithubDown = true;
  const down = await (await call('/api/health/github')).json();
  assert.equal(down.status, 'error');
  mockGithubDown = false;
});

await record('GET /api/health/r2 (real read probe, up/down)', async () => {
  let reads = 0;
  const probing = env({
    MEDIA: {
      ...media,
      get: async (key) => {
        reads++;
        return media.get(key);
      },
    },
  });
  const ok = await (await call('/api/health/r2', { bindings: probing })).json();
  assert.equal(ok.status, 'ok');
  assert.ok(Number.isFinite(ok.latency));
  assert.ok(reads >= 1, 'health probe performs a real read');
  const broken = env({
    MEDIA: {
      ...media,
      get: async () => {
        throw new Error('boom');
      },
    },
  });
  const down = await (await call('/api/health/r2', { bindings: broken })).json();
  assert.equal(down.status, 'error');
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
  await Promise.all(
    [...Array(10)].map((_, i) =>
      call('/api/track/view/race-post', { method: 'POST', headers: { 'CF-Connecting-IP': `10.1.0.${i}` } }),
    ),
  );
  const r = await (await call('/api/stats/race-post')).json();
  assert.equal(r.views, 10);
});

// ── 5c. Stats DO v2 storage schema ──
await record('stats DO v2 schema (s:/day:/meta/agg, no R2 stats mirror)', async () => {
  const keys = [...statsStore.keys()];
  assert.ok(
    keys.some((key) => key.startsWith('s:test-post')),
    'per-post key present',
  );
  assert.ok(
    keys.some((key) => key.startsWith('day:')),
    'per-day key present',
  );
  assert.ok(keys.includes('meta'), 'schema meta written');
  assert.ok(keys.includes('agg'), 'slug registry written');
  assert.equal(statsStore.get('meta').schema, 2);
  assert.ok(!store.has('site-data/stats.json'), 'stats are never mirrored back to R2');
});

await record('view dedupe lives in memory (same IP counted once)', async () => {
  const ip = { 'CF-Connecting-IP': '10.9.9.9' };
  await call('/api/track/view/dedupe-post', { method: 'POST', headers: ip });
  await call('/api/track/view/dedupe-post', { method: 'POST', headers: ip });
  assert.equal((await (await call('/api/stats/dedupe-post')).json()).views, 1);
  await call('/api/track/view/dedupe-post', { method: 'POST', headers: { 'CF-Connecting-IP': '10.9.9.10' } });
  assert.equal((await (await call('/api/stats/dedupe-post')).json()).views, 2);
});

await record('track slug validation (length, slash, dotdot)', async () => {
  for (const slug of ['a'.repeat(121), 'bad%2Fslug']) {
    const r = await call(`/api/track/view/${slug}`, { method: 'POST' });
    assert.equal(r.status, 400, `must reject ${slug}`);
  }
  // `..` cannot reach the route (URL normalisation), so assert the DO guard.
  const dotdot = await statsDO.fetch(
    new Request('https://stats.local/view?slug=..', { method: 'POST', headers: { 'X-Real-IP': '10.4.4.4' } }),
  );
  assert.equal(dotdot.status, 400, 'DO rejects .. itself');
  const long = await statsDO.fetch(
    new Request(`https://stats.local/view?slug=${'a'.repeat(121)}`, {
      method: 'POST',
      headers: { 'X-Real-IP': '10.4.4.5' },
    }),
  );
  assert.equal(long.status, 400);
  assert.equal((await call('/api/track/view/ok-slug', { method: 'POST' })).status, 200);
});

await record('stats reports are protected (/posts, /traffic)', async () => {
  assert.equal((await call('/api/stats/posts')).status, 401);
  assert.equal((await call('/api/stats/traffic')).status, 401);
});

await record('traffic report field-equivalent + cache invalidated by writes', async () => {
  const first = await (await call('/api/stats/traffic', { token: TOKEN })).json();
  for (const key of ['total', 'totalLikes', 'posts', 'byDay', 'byCategory', 'byTag', 'top5'])
    assert.ok(Object.hasOwn(first, key), `traffic exposes ${key}`);
  assert.equal(first.byDay.length, 30, '30-day chart');
  assert.ok(Array.isArray(first.byCategory) && Array.isArray(first.byTag) && Array.isArray(first.top5));
  await call('/api/track/view/traffic-post', { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.99' } });
  const second = await (await call('/api/stats/traffic', { token: TOKEN })).json();
  assert.ok(second.total > first.total, 'a write invalidates the 30s DO traffic cache');
});

await record('GET /api/stats/posts uses one DO call and joins defaults', async () => {
  const body = await (await call('/api/stats/posts', { token: TOKEN })).json();
  assert.ok(body.stats && typeof body.stats === 'object');
  assert.ok(Object.hasOwn(body.stats, 'a'), 'posts without counters default to zero');
  assert.equal(body.stats.a.views, 0);
  assert.ok(typeof body.updatedAt === 'string');
});

// ── 5d. Stats DO v2 migration ──
await record('stats DO v2 migrates legacy map + R2 seed, keeps legacy key 30d', async () => {
  const legacyStore = new Map([
    [
      'stats',
      {
        alpha: {
          views: 4,
          likes: 2,
          dwell_time: 30,
          category: 'Tech/Web',
          tags: ['js'],
          history: [new Date().toISOString()],
        },
        beta: 3,
      },
    ],
  ]);
  const seedStore = new Map([['site-data/stats.json', JSON.stringify({ alpha: { views: 9, likes: 1 } })]]);
  const storage = {
    get: async (key) => (legacyStore.has(key) ? legacyStore.get(key) : null),
    put: async (key, value) => void legacyStore.set(key, value),
    delete: async (key) => void legacyStore.delete(key),
  };
  const seedMedia = {
    get: async (key) => (seedStore.has(key) ? { text: async () => seedStore.get(key) } : null),
    delete: async (key) => void seedStore.delete(key),
  };
  const legacyDO = new StatsDurableObject({ storage }, { MEDIA: seedMedia });
  const alpha = await (
    await legacyDO.fetch(new Request('https://stats.local/stats?slug=alpha', { method: 'POST' }))
  ).json();
  assert.equal(alpha.views, 4, 'in-storage legacy map wins over the R2 seed');
  assert.ok(legacyStore.has('stats'), 'legacy map kept for rollback');
  assert.ok(legacyStore.get('meta').legacyUntil, 'legacy expiry recorded');
  assert.ok(!seedStore.has('site-data/stats.json'), 'one-time R2 seed deleted after import');
  assert.equal(legacyStore.get('s:beta').views, 3, 'legacy map migrated per post');
  const traffic = await (await legacyDO.fetch(new Request('https://stats.local/traffic', { method: 'POST' }))).json();
  assert.equal(traffic.total, 7);
  assert.deepEqual(
    traffic.byCategory,
    [
      { name: 'Tech', count: 4 },
      { name: 'uncategorized', count: 3 },
    ],
    'category split preserved',
  );
  assert.ok(
    traffic.byDay.some((day) => day.count === 1),
    'legacy view history rebuilt into day counters',
  );

  // R2-only seed path (fresh deployment, no in-storage legacy map).
  const freshStore = new Map();
  const freshStorage = {
    get: async (key) => (freshStore.has(key) ? freshStore.get(key) : null),
    put: async (key, value) => void freshStore.set(key, value),
    delete: async (key) => void freshStore.delete(key),
  };
  const r2Only = new Map([['site-data/stats.json', JSON.stringify({ gamma: { views: 5, likes: 1 } })]]);
  const freshDO = new StatsDurableObject(
    { storage: freshStorage },
    {
      MEDIA: {
        get: async (key) => (r2Only.has(key) ? { text: async () => r2Only.get(key) } : null),
        delete: async (key) => void r2Only.delete(key),
      },
    },
  );
  const gamma = await (
    await freshDO.fetch(new Request('https://stats.local/stats?slug=gamma', { method: 'POST' }))
  ).json();
  assert.equal(gamma.views, 5, 'R2 seed imported when no legacy map exists');
  assert.ok(!r2Only.has('site-data/stats.json'), 'R2 seed removed after the one-time import');

  // Bulk endpoint is a single DO round-trip over every tracked slug.
  const bulk = await (await legacyDO.fetch(new Request('https://stats.local/bulk', { method: 'POST' }))).json();
  assert.equal(bulk.stats.alpha.views, 4);
  assert.equal(bulk.stats.beta.views, 3);
});

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
  const r = await call('/api/config', {
    method: 'PUT',
    token: TOKEN,
    body: { components: { gallery: { enabled: false } } },
  });
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
  const rc = await call('/api/taxonomy/category', {
    method: 'PUT',
    token: TOKEN,
    body: { oldName: 'photo', newName: 'photography' },
  });
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
  const tooBig = await call('/api/upload/direct/a/x.jpg', {
    method: 'POST',
    token: TOKEN,
    headers: { 'Content-Length': String(3 * 1024 * 1024 * 1024) },
    body: '{}',
  });
  assert.equal(tooBig.status, 413);
  const ok = await call('/api/upload/direct/a/x.jpg', {
    method: 'POST',
    token: TOKEN,
    headers: { 'Content-Length': '5' },
    body: 'abcde',
  });
  assert.equal(ok.status, 200);
  assert.ok(store.has('originals/a/photos/x.jpg'));
  const favicon = await call('/api/upload/direct/site-data/favicon.svg', {
    method: 'POST',
    token: TOKEN,
    headers: { 'Content-Length': '3' },
    body: '<svg/>',
  });
  assert.equal(favicon.status, 200);
  assert.ok(store.has('site-data/favicon.svg'));
});

// ── 9a. WP1 write-channel hardening ──
await record('site-data whitelist (only favicon.* uploadable)', async () => {
  for (const name of ['robots.txt', 'favicon.exe', 'app.js']) {
    const r = await call(`/api/upload/direct/site-data/${name}`, {
      method: 'POST',
      token: TOKEN,
      headers: { 'Content-Length': '3' },
      body: 'abc',
    });
    assert.equal(r.status, 400, `site-data/${name} must be rejected`);
    assert.ok(!store.has(`site-data/${name}`), 'rejected upload is not written');
  }
  const png = await call('/api/upload/direct/site-data/favicon.png', {
    method: 'POST',
    token: TOKEN,
    headers: { 'Content-Length': '2' },
    body: 'xx',
  });
  assert.equal(png.status, 200);
});

await record('write channels reject reserved slugs + traversal names', async () => {
  for (const slug of ['assets', 'previews', 'drafts']) {
    const direct = await call(`/api/upload/direct/${slug}/x.jpg`, {
      method: 'POST',
      token: TOKEN,
      headers: { 'Content-Length': '1' },
      body: 'x',
    });
    assert.equal(direct.status, 400, `direct upload rejects ${slug}`);
    const presign = await call('/api/upload/presign', {
      method: 'POST',
      token: TOKEN,
      body: { slug, filename: 'x.jpg' },
    });
    assert.equal(presign.status, 400, `presign rejects ${slug}`);
  }
  const siteData = await call('/api/upload/presign', {
    method: 'POST',
    token: TOKEN,
    body: { slug: 'site-data', filename: 'evil.js' },
  });
  assert.equal(siteData.status, 400, 'presign cannot write arbitrary site-data files');
  const complete = await call('/api/upload/complete/assets/x.jpg', { method: 'POST', token: TOKEN });
  assert.equal(complete.status, 400);
});

await record('deleteMediaFile validates slug/filename', async () => {
  store.set('site-data/favicon.svg', 'x');
  const siteData = await call('/api/media/site-data/favicon.svg', { method: 'DELETE', token: TOKEN });
  assert.equal(siteData.status, 400, 'site-data is not a deletable media slug');
  assert.ok(store.has('site-data/favicon.svg'));
  assert.equal((await call('/api/media/assets/x.jpg', { method: 'DELETE', token: TOKEN })).status, 400);
  // Encoded separators/traversal in a param must be rejected, not routed away.
  assert.equal((await call('/api/media/a%2F..%2Fx/x.jpg', { method: 'DELETE', token: TOKEN })).status, 400);
});

await record('serveMediaFile derives folder (2 GETs) + Range → 206', async () => {
  store.set('originals/a/photos/shot.jpg', '0123456789');
  let gets = 0;
  const ranged = {
    ...media,
    get: async (key, options) => {
      gets++;
      if (!store.has(key)) return null;
      const bytes = Buffer.from(store.get(key));
      const range = options?.range;
      if (range) {
        const offset = range.offset || 0;
        const end = range.length ? offset + range.length : bytes.length;
        return {
          body: bytes.subarray(offset, end),
          size: bytes.length,
          httpMetadata: { contentType: 'image/jpeg' },
          httpEtag: 'etag1',
        };
      }
      return { body: bytes, size: bytes.length, httpMetadata: { contentType: 'image/jpeg' }, httpEtag: 'etag1' };
    },
  };
  const bindings = env({ MEDIA: ranged });
  const full = await call('/api/media/file/a/shot.jpg', { bindings });
  assert.equal(full.status, 200);
  assert.equal(await full.text(), '0123456789');
  assert.equal(gets, 2, 'processed miss then originals hit = at most 2 GETs');
  gets = 0;
  const partial = await call('/api/media/file/a/shot.jpg', {
    bindings,
    headers: { Range: 'bytes=2-5' },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');
  assert.ok(gets <= 2, 'range requests never add lookups');
  assert.equal((await call('/api/media/file/a/missing.jpg', { bindings })).status, 404);
  // site-data serving is whitelist-only too.
  assert.equal((await call('/api/media/file/site-data/robots.txt', { bindings })).status, 404);
  assert.equal((await call('/api/media/file/site-data/favicon.svg', { bindings })).status, 200);
});

await record('malformed JSON body → uniform 400 envelope', async () => {
  const r = await call('/api/posts', { method: 'POST', token: TOKEN, body: '{bad json' });
  assert.equal(r.status, 400);
  const data = await r.json();
  assert.equal(data.code, 'INVALID_PARAMS');
  assert.ok(data.error);
});

// ── 9b. Presigned direct upload flow ──
await record('presign URL + complete (direct-to-R2 flow)', async () => {
  const pr = await call('/api/upload/presign', {
    method: 'POST',
    token: TOKEN,
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

await record('multipart upload start/parts/complete/abort/resume', async () => {
  const s = await (
    await call('/api/upload/multipart/start', {
      method: 'POST',
      token: TOKEN,
      body: { slug: 'a', filename: 'big.mp4', size: 350000000, contentType: 'video/mp4' },
    })
  ).json();
  assert.ok(s.uploadId && s.partSize && s.partCount === 4 && s.parts.length === 4, JSON.stringify(s).slice(0, 200));
  const resume = await (
    await call('/api/upload/multipart/start', {
      method: 'POST',
      token: TOKEN,
      body: { slug: 'a', filename: 'big.mp4', size: 350000000, uploadId: s.uploadId },
    })
  ).json();
  assert.equal(resume.uploadId, s.uploadId, 'resume reuses the same uploadId');
  const parts = await (
    await call('/api/upload/multipart/parts', {
      method: 'POST',
      token: TOKEN,
      body: { slug: 'a', filename: 'big.mp4', uploadId: s.uploadId },
    })
  ).json();
  assert.equal(parts.parts.length, 0);
  const emptyComplete = await call('/api/upload/multipart/complete', {
    method: 'POST',
    token: TOKEN,
    body: { slug: 'a', filename: 'big.mp4', uploadId: s.uploadId },
  });
  assert.equal(emptyComplete.status, 400, 'complete without parts must fail');
  const aborted = await call('/api/upload/multipart/abort', {
    method: 'POST',
    token: TOKEN,
    body: { slug: 'a', filename: 'big.mp4', uploadId: s.uploadId },
  });
  assert.equal(aborted.status, 200);
  const staleResume = await call('/api/upload/multipart/start', {
    method: 'POST',
    token: TOKEN,
    body: { slug: 'a', filename: 'big.mp4', size: 350000000, uploadId: s.uploadId },
  });
  assert.equal(staleResume.status, 404, 'resume of an aborted upload must 404');
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

await record('track rate limit (429 after burst, per-IP)', async () => {
  // Fail-closed clientIp: without PROXY_SECRET only CF-Connecting-IP is trusted.
  const h = { 'CF-Connecting-IP': '203.0.113.77' };
  let limitedAt = null;
  for (let i = 0; i < 65; i++) {
    const r = await call('/api/track/view/ratelimit-probe', { method: 'POST', headers: h });
    if (r.status === 429) {
      limitedAt = i + 1;
      break;
    }
  }
  assert.equal(limitedAt, 61, `expected 429 on request 61, got ${limitedAt}`);
  const other = await call('/api/track/view/ratelimit-probe', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '198.51.100.9' },
  });
  assert.equal(other.status, 200, 'a different IP is not rate-limited');
});

await record('clientIp fails closed (X-Real-IP ignored outside DEV_MODE)', async () => {
  const spoof = await clientIp({
    env: { DEV_MODE: 'false' },
    req: { header: (name) => (name === 'X-Real-IP' ? '1.2.3.4' : name === 'CF-Connecting-IP' ? '5.6.7.8' : '') },
  });
  assert.equal(spoof, '5.6.7.8', 'X-Real-IP is caller-controlled and must be ignored');
  const dev = await clientIp({
    env: { DEV_MODE: 'true' },
    req: { header: (name) => (name === 'X-Real-IP' ? '1.2.3.4' : '') },
  });
  assert.equal(dev, '1.2.3.4', 'DEV_MODE keeps the local X-Real-IP fallback');
});

await record('track rate limit global (DO-level 429 after burst)', async () => {
  // The StatsDurableObject is a single instance, so its counter is global
  // across Worker isolates. Hit the DO directly to prove the limit holds even
  // when requests would spread across different Worker isolates.
  const ip = '198.51.100.77';
  let limitedAt = null;
  for (let i = 0; i < 65; i++) {
    const r = await statsDO.fetch(
      new Request('https://stats.local/view?slug=do-ratelimit', {
        method: 'POST',
        headers: { 'X-Real-IP': ip },
      }),
    );
    if (r.status === 429) {
      limitedAt = i + 1;
      break;
    }
  }
  assert.equal(limitedAt, 61, `expected 429 on request 61, got ${limitedAt}`);
});

// ── 11. HMAC client IP verification ──
const signHmac = async (secret, message) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
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
  assert.equal(
    await hmacIp({
      'X-Mosaic-Proxy-IP': ip,
      'X-Mosaic-Proxy-Time': String(bucket),
      'X-Mosaic-Proxy-Sig': sig,
    }),
    ip,
  );
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

// ── 14. Build done hook (dirty lifecycle) ──
await record('build done hook (auth, browser cannot acknowledge deployment)', async () => {
  const unauth = await call('/api/build/done', { method: 'POST', body: { success: true } });
  assert.equal(unauth.status, 401);

  const before = await (await call('/api/dirty', { token: TOKEN })).json();
  assert.ok(before.count >= 1, 'dirty is set (uploads earlier)');

  const ok = await call('/api/build/done', { method: 'POST', token: TOKEN, body: { success: true } });
  assert.equal(ok.status, 200);
  const after = await (await call('/api/dirty', { token: TOKEN })).json();
  assert.equal(after.count, before.count, 'browser success reports cannot clear dirty state');

  const fail = await call('/api/build/done', { method: 'POST', token: TOKEN, body: { success: false } });
  assert.equal(fail.status, 200);
  const reMarked = await (await call('/api/dirty', { token: TOKEN })).json();
  assert.equal(reMarked.count, before.count, 'browser failure reports cannot change dirty state');
});

// ── 15. Build cancel ──
await record('build cancel (auth required, cancels running run)', async () => {
  const unauth = await call('/api/build/cancel', { method: 'POST' });
  assert.equal(unauth.status, 401);
  const r = await call('/api/build/cancel', { method: 'POST', token: TOKEN });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).runNumber, 7);
});

// ── 16. Build dispatch: configurable timeout input ──
await record('build dispatch timeout default 90', async () => {
  mockRunStatus = 'completed';
  try {
    bustCache();
    const r = await call('/api/build', { method: 'POST', token: TOKEN });
    assert.equal(r.status, 200);
    assert.ok(lastDispatchBody, 'dispatch body captured');
    assert.equal(lastDispatchBody.ref, 'main');
    assert.equal(lastDispatchBody.inputs.timeout_minutes, '90');
  } finally {
    mockRunStatus = 'in_progress';
  }
});

await record('build dispatch timeout from config (120) + clamped (999→360, 5→10)', async () => {
  mockRunStatus = 'completed';
  const original = gh.get('mosaic.config.json');
  const setBuild = (timeoutMinutes) =>
    gh.set('mosaic.config.json', JSON.stringify({ ...JSON.parse(original), build: { timeoutMinutes } }));
  try {
    setBuild(120);
    bustCache();
    let r = await call('/api/build', { method: 'POST', token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(lastDispatchBody.inputs.timeout_minutes, '120');

    setBuild(999);
    bustCache();
    r = await call('/api/build', { method: 'POST', token: TOKEN });
    assert.equal(lastDispatchBody.inputs.timeout_minutes, '360');

    setBuild(5);
    bustCache();
    r = await call('/api/build', { method: 'POST', token: TOKEN });
    assert.equal(lastDispatchBody.inputs.timeout_minutes, '10');
  } finally {
    gh.set('mosaic.config.json', original);
    mockRunStatus = 'in_progress';
  }
});

await record('build dispatch timeout fallback 90 (config read fails)', async () => {
  mockRunStatus = 'completed';
  const original = gh.get('mosaic.config.json');
  try {
    gh.delete('mosaic.config.json');
    bustCache();
    const r = await call('/api/build', { method: 'POST', token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(lastDispatchBody.inputs.timeout_minutes, '90');
  } finally {
    gh.set('mosaic.config.json', original);
    mockRunStatus = 'in_progress';
  }
});

await record('GET /api/stats/posts (bulk, structured)', async () => {
  const r = await (await call('/api/stats/posts', { token: TOKEN })).json();
  assert.ok(r.stats && typeof r.stats === 'object');
  assert.ok(Object.hasOwn(r.stats, 'a'));
  assert.ok(typeof r.updatedAt === 'string');
});

await record('GET /api/build/status + history (mock runs)', async () => {
  mockRunStatus = 'completed';
  const s = await (await call('/api/build/status', { token: TOKEN })).json();
  assert.equal(s.runNumber, 7);
  const h = await (await call('/api/build/history', { token: TOKEN })).json();
  assert.ok(Array.isArray(h.runs) && h.runs.length >= 1);
  assert.equal(h.runs[0].runNumber, 7);
  mockRunStatus = 'in_progress';
});

await record('GET /api/build/run/:id (auth + 404 + full detail)', async () => {
  const unauth = await call('/api/build/run/123');
  assert.equal(unauth.status, 401);
  const nf = await call('/api/build/run/999', { token: TOKEN });
  assert.equal(nf.status, 404);
  mockRunStatus = 'completed';
  const r = await (await call('/api/build/run/123', { token: TOKEN })).json();
  assert.equal(r.runNumber, 7);
  assert.ok(Array.isArray(r.steps) && r.steps.length >= 2);
  assert.equal(r.failedStep.number, 2);
  assert.ok(String(r.jobUrl).includes('/job/1'));
  assert.ok(String(r.failedStep.logUrl).includes('#step:2:1'));
  mockRunStatus = 'in_progress';
});

await record('GET /api/build/progress (reads R2 site-data)', async () => {
  const missing = await call('/api/build/progress', { token: TOKEN });
  assert.equal(missing.status, 200);
  await media.put('site-data/build-progress.json', JSON.stringify({ stage: 'media', done: 3, total: 10 }));
  const r = await (await call('/api/build/progress', { token: TOKEN })).json();
  assert.equal(r.stage, 'media');
  assert.equal(r.done, 3);
});

await record('taxonomy delete (tag + category removed from posts)', async () => {
  const rt = await (await call('/api/taxonomy/tag', { method: 'DELETE', token: TOKEN, body: { name: 'z' } })).json();
  assert.ok(rt.affected >= 1);
  const md = gh.get('content/posts/a/index.md');
  assert.ok(!md.includes('"z"') && !md.includes('z,'));
  const rc = await (
    await call('/api/taxonomy/category', { method: 'DELETE', token: TOKEN, body: { name: 'photography' } })
  ).json();
  assert.ok(rc.affected >= 1);
  assert.ok(!gh.get('content/posts/a/index.md').includes('photography'));
});

await record('GET /api/posts pagination (limit/cursor)', async () => {
  const all = await (await call('/api/posts?limit=0', { token: TOKEN })).json();
  assert.ok(Array.isArray(all.posts) && all.posts.length >= 1);
  const one = await (await call('/api/posts?limit=1', { token: TOKEN })).json();
  assert.equal(one.posts.length, 1);
  assert.ok('total' in one);
});

await record('GET /api/disk (parallel usage)', async () => {
  const d = await (await call('/api/disk', { token: TOKEN })).json();
  assert.ok(Number.isFinite(d.objects) && d.objects >= 1);
  assert.ok(Number.isFinite(parseFloat(d.sizeMB)));
});

await record('cleanup scan/delete orphan (R2)', async () => {
  store.set('originals/ghost-post/x.jpg', 'x');
  const assetKey = 'originals/assets/ast_0123456789abcdefghjkmnpq/clip.mp4';
  store.set(assetKey, 'asset-source');
  const scan = await (await call('/api/cleanup', { token: TOKEN })).json();
  assert.ok(scan.totalOrphans >= 1 && scan.orphans.some((o) => o.key.includes('ghost-post')));
  assert.ok(!scan.orphans.some((o) => o.key === assetKey), 'v2 asset source is never an orphan');
  const del = await (await call('/api/cleanup', { method: 'DELETE', token: TOKEN })).json();
  assert.ok(del.deleted >= 1);
  assert.ok(!store.has('originals/ghost-post/x.jpg'));
  assert.ok(store.has(assetKey), 'cleanup leaves v2 originals to the asset lifecycle');
});

await record('GET /api/dirty (count state)', async () => {
  const r = await (await call('/api/dirty', { token: TOKEN })).json();
  assert.ok(Number.isInteger(r.count) && r.count >= 0);
});

globalThis.fetch = realFetch;
console.log(results.map((r) => `  ${r}`).join('\n'));
console.log(`\nWorker smoke: ${passed} groups passed`);
if (passed < 51) process.exit(1);
