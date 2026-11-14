import assert from 'node:assert/strict';
import { normalizeConfig } from '../../../shared/config.mjs';
import { defineJourney, waitFor } from '../lib/journey.mjs';

export const area = 'admin';
/** only runs against the mocked admin-local stack */
export const targets = ['admin-local'];

const fixture = {
  slug: 'fixture-post',
  sha: 'fixture-sha',
  frontMatter: {
    title: 'Fixture post',
    date: '2026-08-03T00:00:00.000Z',
    category: null,
    tags: ['极简', '随笔'],
    description: null,
    cover: 'video:0',
    views: 3,
    likes: 2,
    media: { gallery: ['asset-1'], videos: [], music: [], cover: null },
  },
  body: '{{photo:0}}\n\n你好。a\n',
};

async function openEditor(t, post = fixture) {
  t.assertEqual(t.target, 'admin-local', 'round-trip journeys require the mocked local admin');
  const writes = t.writeAttempts;
  const saves = [];
  const config = normalizeConfig({ url: t.base, mediaBase: t.base, admin: { jobPollMs: 100 } });
  await t.page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== t.base) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const pathname = url.pathname.slice(4);
    const method = request.method();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) writes.push(`${method} ${url.pathname}`);
    let body = { ok: true };
    if (pathname === '/posts' && ['POST', 'PUT'].includes(method)) {
      saves.push(request.postDataJSON());
      body = { ok: true, slug: post.slug, sha: 'saved-sha' };
    } else if (pathname === '/auth/login') body = { token: 'fixture-token' };
    else if (pathname === '/config') body = config;
    else if (pathname === '/posts') body = { posts: [{ slug: post.slug, ...post.frontMatter }], total: 1 };
    else if (pathname === `/posts/${post.slug}`) body = post;
    else if (pathname === '/dirty') body = { dirty: false };
    else if (pathname === '/stats') body = { posts: 1, categories: 0, tags: 2 };
    else if (pathname === '/stats/traffic') body = { total: 1, byDay: [], byCategory: [], byTag: [], top5: [] };
    else if (pathname === '/stats/posts') body = { stats: {} };
    else if (pathname.startsWith('/health')) body = { status: 'ok', latency: 1 };
    else if (pathname === '/taxonomy') body = { categories: [], tags: [] };
    else if (pathname === '/build/status') body = { status: 'unknown' };
    else if (pathname === '/build/history') body = { runs: [] };
    else if (pathname === '/tasks') body = { tasks: [] };
    else if (pathname === '/media-jobs') body = { jobs: [] };
    else if (pathname === '/disk') body = { sizeMB: 1, objects: 1, cost: 0 };
    else if (pathname === '/assets') body = { assets: [] };
    else if (pathname.endsWith('/list'))
      body = {
        photos: [{ name: 'photo.jpg', status: 'ready' }],
        videos: [{ name: 'clip.mp4', status: 'ready' }],
        music: [],
        covers: [],
      };
    await route.fulfill({ json: body });
  });
  await t.goto('/');
  await t.page.locator('#login-password').fill('fixture-password');
  await t.page.locator('#login-btn').click();
  await t.page.locator('#app').waitFor({ state: 'visible' });
  assert.deepEqual(writes, ['POST /api/auth/login'], 'bootstrap only writes to login');
  // Audit all editor writes after the expected authentication request.
  writes.length = 0;
  await t.page.evaluate(() => (location.hash = 'editor&slug=fixture-post'));
  await waitFor(async () => (await t.page.locator('#fm-title').inputValue()) === post.frontMatter.title, {
    message: 'fixture form populated',
  });
  // Wait for the background media load so indexed placeholders render as blocks.
  await t.page.locator('.fm-media-single').waitFor({ state: 'attached' });
  return {
    async save() {
      await t.page.locator('#editor-save-btn').click();
      await waitFor(() => saves.length === 1, { message: 'post save request' });
      await waitFor(async () => !(await t.page.locator('#editor-save-btn').isDisabled()), {
        message: 'save completed',
      });
      assert.deepEqual(
        writes.filter((entry) => entry !== 'DELETE /api/taxonomy/category'),
        ['POST /api/posts'],
        'only the expected post save may write to the API',
      );
      return saves[0];
    },
  };
}

export const journeys = [
  defineJourney({
    id: 'admin-roundtrip',
    title: 'An untouched post save preserves typed metadata, media and the original body',
    priority: 'P0',
    steps: async (t) => {
      const editor = await openEditor(t);
      assert.equal(await t.page.locator('#fm-date').inputValue(), '2026-08-03');
      assert.equal(await t.page.locator('#fm-category').inputValue(), '');
      assert.equal(await t.page.locator('#fm-desc').inputValue(), '');
      const saved = await editor.save();
      assert.deepEqual(saved.frontMatter, fixture.frontMatter);
      assert.equal(saved.body, fixture.body);
      assert.equal(saved.baseSha, fixture.sha);
    },
  }),
  defineJourney({
    id: 'admin-roundtrip-empty-media',
    title: 'An untouched save keeps empty media, timestamp time and body whitespace',
    priority: 'P0',
    steps: async (t) => {
      const post = structuredClone(fixture);
      post.frontMatter.date = '2026-08-03T14:25:36.789Z';
      post.frontMatter.media = { gallery: [], videos: [], music: [], cover: null };
      post.body = '  {{photo:0}}  \r\n\r\n你好。a  \r\n\r\n';
      const editor = await openEditor(t, post);
      const saved = await editor.save();
      assert.deepEqual(saved.frontMatter, post.frontMatter);
      assert.equal(saved.body, post.body);
    },
  }),
  defineJourney({
    id: 'admin-roundtrip-edited-body',
    title: 'Editing text preserves indexed tokens and normalizes changed metadata',
    priority: 'P0',
    steps: async (t) => {
      const post = structuredClone(fixture);
      post.body = '{{video:0}}\n\n{{photo:0}}\n\n你好。a\n';
      const editor = await openEditor(t, post);
      await t.page.locator('.fm-text-block').fill('Edited text');
      await t.page.locator('#fm-date').fill('2026-08-04');
      await t.page.locator('#fm-category').fill('  随笔  ');
      await t.page.locator('#fm-desc').fill('  Description  ');
      await t.page.locator('#fm-tags').fill(' 极简, , 随笔 , ');
      await t.page.locator('#fm-cover').fill('  ');
      await t.page.locator('#fm-views').fill('4.9');
      await t.page.locator('#fm-likes').fill('');
      const saved = await editor.save();
      assert.equal(saved.body, '{{video:0}}\n\n{{photo:0}}\n\nEdited text\n');
      assert.deepEqual(saved.frontMatter, {
        ...post.frontMatter,
        date: '2026-08-04T00:00:00.000Z',
        category: '随笔',
        description: 'Description',
        cover: null,
        views: 4,
        likes: 0,
      });
    },
  }),
];
