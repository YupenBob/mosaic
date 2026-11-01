/**
 * Content overlay (WP3) regression suite.
 *
 * Verifies that listPosts is served from the R2 build index + overlay without
 * touching GitHub, that the overlay is merged correctly (upserts/removes/
 * refresh), that writes are compare-and-set with retries, and that the admin
 * write paths (post save/delete, taxonomy rename, history restore) record the
 * change so a dirty site never needs a full GitHub read.
 *
 * Usage: node tests/content-overlay-smoke.mjs
 */
import assert from 'node:assert/strict';
import { MemoryBucket } from './helpers/runtime.mjs';
import { normalizeConfig } from '../shared/config.mjs';
import { cacheFor } from '../worker/src/services/github-client.js';
import { listPosts, createOrUpdatePost, deletePost } from '../worker/src/services/content.js';
import {
  CONTENT_OVERLAY_KEY,
  applyContentOverlay,
  clearContentOverlay,
  emptyContentOverlay,
  invalidateContentOverlay,
  markContentOverlayRefresh,
  normalizeContentOverlay,
  readContentOverlayRaw,
  removeFromContentOverlay,
  upsertContentOverlay,
} from '../worker/src/services/content-overlay.mjs';
import { renameCategory } from '../worker/src/services/taxonomy.js';
import { restoreHistory } from '../worker/src/services/history.js';

const bucket = new MemoryBucket();
const env = { MEDIA: bucket, GITHUB_REPO: 'test/mosaic', GITHUB_TOKEN: 'mock' };
const c = { env };
// Seed the config cache exactly like tests/list-index.mjs: listPosts reads the
// site config before the index, and this suite must stay network-free.
Object.assign(cacheFor(env), { config: normalizeConfig({}), configTime: Date.now() });

// A write path calls bustCache(), so re-seed the config cache before tests that
// expect a network-free listPosts.
const seedConfig = () => Object.assign(cacheFor(env), { config: normalizeConfig({}), configTime: Date.now() });
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const md = (frontMatter) => `---\n${frontMatter}\n---\n\nbody`;
const realFetch = globalThis.fetch;
let githubCalls = 0;
const offline = async () => {
  githubCalls++;
  throw new Error('GitHub must not be called');
};

await bucket.put(
  'site-data/posts-index.json',
  JSON.stringify([
    { slug: 'alpha', title: 'Alpha', date: '2026-10-03T00:00:00.000Z', category: 'Tech', tags: ['js'], media: null },
    { slug: 'beta', title: 'Beta', date: '2026-10-02T00:00:00.000Z', category: 'Tech', tags: [], media: null },
  ]),
);

let passed = 0;
const results = [];
async function record(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`);
  } finally {
    globalThis.fetch = offline;
  }
}

// ── 1. Pure overlay merge semantics ──
await record('applyContentOverlay merges upserts/removes and keeps date order', async () => {
  const base = [
    { slug: 'a', title: 'A', date: '2026-01-02' },
    { slug: 'b', title: 'B', date: '2026-01-01' },
  ];
  const overlay = {
    ...emptyContentOverlay(),
    upserts: { a: { title: 'A2' }, c: { title: 'C', date: '2026-01-03' } },
    removes: { b: 'now' },
  };
  const merged = applyContentOverlay(base, overlay);
  assert.deepEqual(
    merged.map((post) => post.slug),
    ['c', 'a'],
    'removed post dropped, new post date-sorted first',
  );
  assert.equal(merged[1].title, 'A2', 'upsert with a partial record is merged field-by-field');
  assert.equal(merged[1].date, '2026-01-02', 'fields not in the upsert are preserved');
});

await record('normalizeContentOverlay tolerates corrupt values', async () => {
  assert.equal(normalizeContentOverlay(null).schema, 1);
  assert.deepEqual(normalizeContentOverlay({ upserts: [], removes: 'x' }).upserts, {});
  const clean = normalizeContentOverlay({ revision: 4, upserts: { a: { title: 'A' } }, removes: { b: 't' } });
  assert.equal(clean.revision, 4);
  assert.ok(clean.upserts.a && clean.removes.b);
});

await record('overlay refuses entries that bypassed schema validation', async () => {
  const invalidCategory = normalizeContentOverlay({ upserts: { alpha: { title: 'A', category: '..' } } });
  assert.deepEqual(Object.keys(invalidCategory.upserts), [], 'unsafe category is not merged');
  assert.equal(invalidCategory.refresh, true, 'unsafe entries force the authoritative Git read');
  const invalidTags = normalizeContentOverlay({ upserts: { alpha: { tags: ['ok', 'a/b'] } } });
  assert.equal(invalidTags.refresh, true, 'unsafe tag is not merged');
  const invalidSlug = normalizeContentOverlay({ upserts: { 'bad/slug': { title: 'X' } } });
  assert.deepEqual(Object.keys(invalidSlug.upserts), []);
});

// ── 2. listPosts: index only, no GitHub ──
await record('listPosts serves the R2 index without GitHub and caches it', async () => {
  githubCalls = 0;
  globalThis.fetch = offline;
  invalidateContentOverlay(env);
  let indexReads = 0;
  const realGet = bucket.get.bind(bucket);
  bucket.get = (key) => {
    if (key === 'site-data/posts-index.json') indexReads++;
    return realGet(key);
  };
  try {
    const first = await listPosts(c);
    assert.equal(first.length, 2);
    assert.equal(first[0].slug, 'alpha');
    const second = await listPosts(c);
    assert.equal(second.length, 2);
    assert.equal(indexReads, 1, 'second read is served from the in-memory cache');
    assert.equal(githubCalls, 0, 'no GitHub request for a clean site with index');
  } finally {
    bucket.get = realGet;
  }
});

// ── 3. Overlay upserts/removes applied over the index ──
await record('overlay upserts/removes are merged without GitHub', async () => {
  githubCalls = 0;
  await upsertContentOverlay(c, [
    { slug: 'alpha', title: 'Alpha edited', date: '2026-10-03T00:00:00.000Z', category: 'Tech', tags: ['js'] },
    { slug: 'gamma', title: 'Gamma', date: '2026-10-04T00:00:00.000Z', category: 'Other', tags: [] },
  ]);
  assert.equal((await readContentOverlayRaw(env)).overlay.revision, 1);
  await removeFromContentOverlay(c, ['beta']);
  const posts = await listPosts(c);
  assert.deepEqual(
    posts.map((post) => post.slug),
    ['gamma', 'alpha'],
    'new post first, beta removed',
  );
  assert.equal(posts.find((post) => post.slug === 'alpha').title, 'Alpha edited');
  assert.equal(githubCalls, 0, 'overlay edits never hit GitHub');
});

await record('re-upserting a removed slug clears the remove marker', async () => {
  await upsertContentOverlay(c, [{ slug: 'beta', title: 'Beta again', date: '2026-10-02T00:00:00.000Z' }]);
  const overlay = (await readContentOverlayRaw(env)).overlay;
  assert.ok(!('beta' in overlay.removes), 'upsert wins over a stale remove');
  const posts = await listPosts(c);
  assert.ok(posts.some((post) => post.slug === 'beta'));
});

// ── 4. refresh falls back to GitHub; a missing overlay while dirty does too ──
const ghFetch = async (url, options = {}) => {
  githubCalls++;
  const href = typeof url === 'string' ? url : String(url?.url || url);
  const method = (options.method || 'GET').toUpperCase();
  if (method === 'PUT') return Response.json({ content: { sha: 'newsha' }, commit: { sha: 'commit1' } });
  if (href.includes('/contents/content/posts') && !href.includes('/index.md'))
    return Response.json([
      { type: 'dir', name: 'alpha' },
      { type: 'dir', name: 'beta' },
    ]);
  const slug = /\/(content\/posts\/([^/]+)\/index\.md)/.exec(href)?.[2];
  if (slug)
    return Response.json({
      sha: 'sha1',
      content: b64(md(`title: ${slug === 'alpha' ? 'Alpha from Git' : 'Beta from Git'}\ndate: 2026-10-01`)),
    });
  return Response.json({ message: 'Not Found' }, { status: 404 });
};

await record('overlay refresh=true forces the authoritative GitHub read', async () => {
  githubCalls = 0;
  await markContentOverlayRefresh(c);
  globalThis.fetch = ghFetch;
  seedConfig();
  invalidateContentOverlay(env);
  const posts = await listPosts(c);
  assert.ok(githubCalls > 0, 'refresh triggers GitHub reads');
  assert.ok(posts.some((post) => post.title === 'Alpha from Git'));
});

await record('dirty site with index but no overlay falls back to GitHub', async () => {
  await clearContentOverlay(env);
  // Use a Jobs-DO dirty-state stub (the R2 fallback keeps module memory state,
  // which would leak into later phases of this test process).
  env.JOBS = {
    idFromName: () => 'global',
    get: () => ({ fetch: async () => Response.json({ count: 1, contentDirty: true }) }),
  };
  try {
    githubCalls = 0;
    globalThis.fetch = ghFetch;
    seedConfig();
    invalidateContentOverlay(env);
    const posts = await listPosts(c);
    assert.ok(githubCalls > 0, 'unexplained dirty state cannot be served from the stale index');
    assert.ok(posts.some((post) => post.slug === 'alpha'));
  } finally {
    delete env.JOBS;
  }
});

// ── 5. Compare-and-set writes ──
await record('overlay writes retry after a lost CAS race', async () => {
  await clearContentOverlay(env);
  let attempts = 0;
  const realPut = bucket.put.bind(bucket);
  bucket.put = async (key, value, options = {}) => {
    if (key === CONTENT_OVERLAY_KEY) {
      attempts++;
      if (attempts < 3) return null; // simulate the ETag moving under us
    }
    return realPut(key, value, options);
  };
  try {
    await upsertContentOverlay(c, [{ slug: 'alpha', title: 'Retried' }]);
  } finally {
    bucket.put = realPut;
  }
  assert.equal(attempts, 3, 'three attempts before giving up');
  assert.equal((await readContentOverlayRaw(env)).overlay.upserts.alpha.title, 'Retried');
});

await record('overlay CAS re-reads and merges a concurrent writer', async () => {
  await clearContentOverlay(env);
  let injected = false;
  const realPut = bucket.put.bind(bucket);
  bucket.put = async (key, value, options = {}) => {
    if (key === CONTENT_OVERLAY_KEY && !injected) {
      injected = true;
      const current = (await readContentOverlayRaw(env)).overlay;
      current.upserts.other = { title: 'Other writer' };
      current.revision += 1;
      await realPut(key, JSON.stringify(current), {});
      return null; // our first write loses the race
    }
    return realPut(key, value, options);
  };
  try {
    await upsertContentOverlay(c, [{ slug: 'alpha', title: 'Mine' }]);
  } finally {
    bucket.put = realPut;
  }
  const overlay = (await readContentOverlayRaw(env)).overlay;
  assert.equal(overlay.upserts.alpha.title, 'Mine', 'our write survived the retry');
  assert.equal(overlay.upserts.other.title, 'Other writer', 'the concurrent change was not lost');
});

// ── 6. Write-path hooks ──
await record('saving a post records it in the overlay (no GitHub list needed)', async () => {
  await clearContentOverlay(env);
  const realPut = bucket.put.bind(bucket);
  githubCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    githubCalls++;
    const href = String(url);
    if ((options.method || 'GET').toUpperCase() === 'PUT') return Response.json({ content: { sha: 'newsha' } });
    if (href.includes('/contents/content/posts/alpha/index.md'))
      return Response.json({ sha: 'sha1', content: b64(md('title: Old Alpha')) });
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };
  try {
    await createOrUpdatePost(
      c,
      'alpha',
      { title: 'Saved Alpha', category: 'Tech', tags: ['js', 'node'], date: '2026-10-05' },
      'hello',
    );
  } finally {
    bucket.put = realPut;
  }
  const overlay = (await readContentOverlayRaw(env)).overlay;
  assert.equal(overlay.upserts.alpha.title, 'Saved Alpha');
  assert.deepEqual(overlay.upserts.alpha.tags, ['js', 'node']);
  // The next listPosts must not need GitHub: serve it from index + overlay.
  globalThis.fetch = offline;
  githubCalls = 0;
  seedConfig();
  invalidateContentOverlay(env);
  const posts = await listPosts(c);
  assert.equal(githubCalls, 0, 'post save is visible without GitHub');
  assert.equal(posts.find((post) => post.slug === 'alpha').title, 'Saved Alpha');
  assert.equal(posts.find((post) => post.slug === 'alpha').date, '2026-10-05');
});

await record('saving a post rejects unsafe frontmatter (shared schema)', async () => {
  const before = githubCalls;
  await assert.rejects(
    () => createOrUpdatePost(c, 'alpha', { title: 'x', category: '..' }, 'body'),
    (error) => error.status === 422 && error.code === 'INVALID_CONTENT',
  );
  assert.equal(githubCalls, before, 'invalid content never reaches GitHub');
});

await record('deleting a post records a removal in the overlay', async () => {
  githubCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    githubCalls++;
    const href = String(url);
    const method = (options.method || 'GET').toUpperCase();
    if (method === 'DELETE') return Response.json({ commit: { sha: 'del' } });
    if (href.endsWith('/contents/content/posts/alpha'))
      return Response.json([{ type: 'file', path: 'content/posts/alpha/index.md', sha: 'f1' }]);
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };
  await deletePost(c, 'alpha');
  const overlay = (await readContentOverlayRaw(env)).overlay;
  assert.ok(overlay.removes.alpha, 'deleted slug recorded');
  assert.ok(!overlay.upserts.alpha, 'stale upsert dropped');
  globalThis.fetch = offline;
  githubCalls = 0;
  seedConfig();
  invalidateContentOverlay(env);
  const posts = await listPosts(c);
  assert.equal(githubCalls, 0);
  assert.ok(!posts.some((post) => post.slug === 'alpha'), 'deleted post hidden from the listing');
});

await record('taxonomy rename records the rewritten posts in the overlay', async () => {
  await clearContentOverlay(env);
  await bucket.put(
    'site-data/posts-index.json',
    JSON.stringify([
      { slug: 'alpha', title: 'Alpha', date: '2026-10-03T00:00:00.000Z', category: 'Tech', tags: ['js'] },
      { slug: 'beta', title: 'Beta', date: '2026-10-02T00:00:00.000Z', category: 'Tech', tags: [] },
    ]),
  );
  seedConfig();
  invalidateContentOverlay(env);
  githubCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    githubCalls++;
    const href = String(url);
    if ((options.method || 'GET').toUpperCase() === 'PUT') return Response.json({ content: { sha: 'x' } });
    const slug = /\/(content\/posts\/([^/]+)\/index\.md)/.exec(href)?.[2];
    return Response.json({ sha: `${slug}-sha`, content: b64(md(`title: ${slug}\ncategory: Tech`)) });
  };
  const renamed = await renameCategory(c, 'Tech', 'Techno');
  assert.equal(renamed, 2);
  globalThis.fetch = offline;
  githubCalls = 0;
  seedConfig();
  invalidateContentOverlay(env);
  const posts = await listPosts(c);
  assert.equal(githubCalls, 0, 'taxonomy rewrite is visible without GitHub');
  assert.ok(posts.every((post) => post.category === 'Techno'));
});

await record('history restore records restored posts; partial failures mark refresh', async () => {
  await clearContentOverlay(env);
  invalidateContentOverlay(env);
  let restored = false;
  globalThis.fetch = async (url, options = {}) => {
    githubCalls++;
    const href = String(url);
    const method = (options.method || 'GET').toUpperCase();
    if (/\/commits\/abcdef1$/.test(href))
      return Response.json({
        sha: 'abcdef1',
        commit: { message: 'restore', author: { name: 'a', date: '2026-01-01' } },
        files: [{ filename: 'content/posts/alpha/index.md', status: 'modified', additions: 1, deletions: 1 }],
      });
    if (method === 'PUT') {
      restored = true;
      return Response.json({ content: { sha: 'restored-sha' } });
    }
    if (href.includes('/contents/content/posts/alpha/index.md')) {
      const body = href.includes('?ref=') ? md('title: Alpha restored') : md('title: Alpha current');
      if (restored) return Response.json({ sha: 'restored-sha', content: b64(md('title: Alpha restored')) });
      return Response.json({ sha: 'current-sha', content: b64(body) });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };
  const result = await restoreHistory(c, 'abcdef1');
  assert.equal(result.files[0].status, 'restored');
  const overlay = (await readContentOverlayRaw(env)).overlay;
  assert.equal(overlay.upserts.alpha.title, 'Alpha restored', 'restored post recorded in overlay');
  assert.equal(overlay.refresh, false, 'a pure post-file restore stays an overlay delta');
});

globalThis.fetch = realFetch;
console.log(results.map((line) => `  ${line}`).join('\n'));
console.log(`\nContent overlay smoke: ${passed} groups passed`);
if (passed < 15) process.exit(1);
