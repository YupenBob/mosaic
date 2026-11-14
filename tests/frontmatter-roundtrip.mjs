/** Worker frontmatter regressions: real posts and mocked admin saves, no network. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import matter from 'gray-matter';
import {
  normalizeFrontMatter,
  parseFrontMatter,
  parsePostContent,
  serializePostContent,
} from '../worker/src/services/frontmatter.js';
import { parseFrontMatter as githubParseFrontMatter } from '../worker/src/services/github-client.js';
import {
  createOrUpdatePost,
  getPost,
  normalizeFrontMatter as contentNormalize,
} from '../worker/src/services/content.js';
import { CONTENT_OVERLAY_KEY } from '../worker/src/services/content-overlay.mjs';

const json = (value) => JSON.parse(JSON.stringify(value));
const invalidContent = (error) => error.status === 422 && error.code === 'INVALID_CONTENT';
assert.equal(githubParseFrontMatter, parseFrontMatter, 'GitHub helper keeps its public export');
assert.equal(contentNormalize, normalizeFrontMatter, 'content helper re-exports the pure normalizer');

function roundTrip(frontMatter, body, label) {
  const expected = normalizeFrontMatter(frontMatter);
  const payload = json({ frontMatter, body });
  const normalized = normalizeFrontMatter(payload.frontMatter);
  assert.deepEqual(normalized, expected, `${label}: normalization survives the API JSON boundary`);
  const saved = serializePostContent(normalized, payload.body);
  const reparsed = parsePostContent(saved);
  assert.deepEqual(reparsed.frontMatter, expected, `${label}: saved YAML retains normalized types`);
  assert.equal(reparsed.body, body, `${label}: body retains every blank line and placeholder`);
  assert.ok(saved.endsWith('\n'), `${label}: saved file has a final newline`);
}

const posts = new URL('../content/posts/', import.meta.url);
let validPosts = 0;
for (const entry of await readdir(posts, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = new URL(`${entry.name}/index.md`, posts);
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  const { frontMatter, body } = parsePostContent(source);
  const buildParsed = matter(source);
  assert.deepEqual(frontMatter, buildParsed.data, `${entry.name}: matches the build's default YAML schema`);
  assert.equal(body, buildParsed.content.replace(/^\r?\n/, ''), `${entry.name}: only the separator is removed`);
  // Even invalid legacy posts must parse/serialize losslessly. Saving them must
  // reject the invalid title; tests must never repair production files on disk.
  assert.deepEqual(parsePostContent(serializePostContent(frontMatter, body)), { frontMatter, body }, entry.name);
  // Legacy posts without a title must survive an admin save unchanged.
  roundTrip(frontMatter, body, entry.name);
  validPosts++;
}
assert.ok(validPosts > 0, 'the corpus must contain posts');

const edge = `\uFEFF---
title: '007'
category: null
description: null
cover: 'video:0'
date: 2026-08-03T12:34:56.789Z
tags:
  - 极简
  - 随笔
media:
  cover: null
  gallery: [ast_photo_1, ast_photo_2]
  videos:
    - ast_video_1
  music: []
---


  Intentional indentation  

{{video:0}}
---
{{gallery}}


`;
const parsed = parsePostContent(edge);
assert.deepEqual(parsed.frontMatter, {
  title: '007',
  category: null,
  description: null,
  cover: 'video:0',
  date: new Date('2026-08-03T12:34:56.789Z'),
  tags: ['极简', '随笔'],
  media: { cover: null, gallery: ['ast_photo_1', 'ast_photo_2'], videos: ['ast_video_1'], music: [] },
});
assert.equal(parsed.body, '\n  Intentional indentation  \n\n{{video:0}}\n---\n{{gallery}}\n\n\n');
roundTrip(parsed.frontMatter, parsed.body, 'BOM, nulls, quoted scalars, block tags, nested media');
assert.deepEqual(parseFrontMatter('---\ntitle: x\ntags: [极简, "随笔"]\n---\n').tags, ['极简', '随笔']);
assert.equal(parseFrontMatter('---\ntitle: "true"\ncover: "123"\n---\n').cover, '123');
assert.deepEqual(parseFrontMatter('No frontmatter\n---\ntitle: body text\n---\n'), {});
assert.deepEqual(parseFrontMatter('\uFEFFBody only'), {});
assert.deepEqual(parseFrontMatter('---\n---\n'), {});
assert.throws(() => parseFrontMatter('---\n- not a mapping\n---\n'), invalidContent);
assert.throws(() => parseFrontMatter('---\ntitle: [broken\n---\n'));
assert.equal(parsePostContent(edge.replace(/\n/g, '\r\n')).body, parsed.body.replace(/\n/g, '\r\n'));

const input = { title: '  Title  ', date: ' 2026-05-01 ', tags: [' 极简 ', '', ' 随笔 '], views: '12', likes: 3.9 };
const before = structuredClone(input);
assert.deepEqual(normalizeFrontMatter(input), {
  title: 'Title',
  date: '2026-05-01T00:00:00.000Z',
  tags: ['极简', '随笔'],
  views: 12,
  likes: 3,
});
assert.deepEqual(input, before, 'normalization does not mutate input');
assert.deepEqual(normalizeFrontMatter({ title: 'x', tags: ' 极简, ,随笔, ' }).tags, ['极简', '随笔']);
assert.ok(!Object.hasOwn(normalizeFrontMatter({ title: 'x', tags: undefined }), 'tags'));
assert.equal(normalizeFrontMatter({ title: 'x', date: new Date('2026-05-01') }).date, '2026-05-01T00:00:00.000Z');
const fullIso = '2026-05-01T12:34:56.123+08:00';
assert.equal(normalizeFrontMatter({ title: 'x', date: fullIso }).date, fullIso, 'full ISO keeps time and offset');
roundTrip({ title: 'x', date: '2024-02-29', tags: 'a,b' }, '\nBody\n\n', 'date-only leap day and comma tags');

for (const sentinel of ['null', 'undefined', '[object Object]']) {
  const normalized = normalizeFrontMatter({ title: 'x', category: sentinel, description: sentinel, cover: sentinel });
  assert.deepEqual(normalized, { title: 'x', category: null, description: null, cover: null });
  for (const field of ['title', 'date', 'tags', 'views', 'likes', 'custom']) {
    assert.throws(() => normalizeFrontMatter({ title: 'x', [field]: sentinel }), invalidContent, field);
  }
  assert.throws(() => normalizeFrontMatter({ title: 'x', tags: ['ok', sentinel] }), invalidContent);
  assert.throws(() => normalizeFrontMatter({ title: 'x', tags: `ok, ${sentinel}` }), invalidContent);
  assert.throws(() => normalizeFrontMatter({ title: 'x', custom: { value: sentinel } }), invalidContent);
}
assert.equal(normalizeFrontMatter({ title: 'x', category: ' Null ' }).category, 'Null', 'sentinels are case sensitive');
assert.equal(normalizeFrontMatter({ title: 'x', cover: ' null ' }).cover, null, 'strings are trimmed first');
for (const date of [
  'nonsense',
  '2026-02-30',
  '2026-13-01',
  '2026-05-01T24:00:00Z',
  'May 1, 2026',
  '',
  null,
  123,
  new Date(NaN),
]) {
  assert.throws(() => normalizeFrontMatter({ title: 'x', date }), invalidContent, String(date));
}
for (const title of [undefined, null, '', '  ']) {
  assert.doesNotThrow(() => normalizeFrontMatter({ title }), `legacy/cleared title ${String(title)} is allowed`);
}
for (const title of [123, {}, []]) {
  assert.throws(() => normalizeFrontMatter({ title }), invalidContent);
}
for (const frontMatter of [undefined, null, [], 'title: x']) {
  assert.throws(() => normalizeFrontMatter(frontMatter), invalidContent);
}
for (const tags of [null, 123, {}, ['ok', 123]]) {
  assert.throws(() => normalizeFrontMatter({ title: 'x', tags }), invalidContent);
}
for (const field of ['views', 'likes']) {
  for (const value of [-1, '-1', 'bad', '', null, true, Infinity, NaN]) {
    assert.throws(() => normalizeFrontMatter({ title: 'x', [field]: value }), invalidContent, field);
  }
}

const custom = normalizeFrontMatter({
  title: 'x',
  custom: { enabled: true, count: 2, empty: null, text: '  safe  ', list: [' a ', 'b'] },
  omitted: undefined,
  'bad:key': 'excluded',
});
const customYaml = serializePostContent(custom, 'Body without newline');
const customParsed = parsePostContent(customYaml);
assert.deepEqual(customParsed.frontMatter, {
  title: 'x',
  custom: { enabled: true, count: 2, empty: null, text: 'safe', list: ['a', 'b'] },
});
assert.equal(customParsed.body, 'Body without newline\n');
assert.equal(parsePostContent(serializePostContent({ title: 'x' }, '')).body, '');
const shared = { nested: true };
assert.ok(!/[&*]ref_/.test(serializePostContent({ title: 'x', one: shared, two: shared })), 'no YAML references');

// Exercise the actual save/read path, with every external operation mocked.
const realFetch = globalThis.fetch;
let storedPost = edge;
let writes = 0;
const bucket = new Map([
  [
    'site-data/posts-index.json',
    JSON.stringify([{ slug: 'fixture', category: 'old', description: 'old', cover: 'old' }]),
  ],
]);
const context = {
  env: {
    GITHUB_REPO: 'fixture/mosaic',
    MEDIA: {
      get: async (key) => (bucket.has(key) ? { text: async () => bucket.get(key) } : null),
      put: async (key, value) => {
        bucket.set(key, value);
      },
    },
  },
};
try {
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(String(url).includes('/contents/content/posts/fixture/index.md'), 'unexpected network request');
    if (init.method === 'PUT') {
      storedPost = Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8');
      writes++;
      return Response.json({ content: { sha: 'new-sha' } });
    }
    return Response.json({ content: Buffer.from(storedPost).toString('base64'), sha: 'old-sha' });
  };
  const loaded = json(await getPost(context, 'fixture'));
  assert.equal(loaded.body, parsed.body, 'getPost preserves body whitespace');
  await createOrUpdatePost(context, 'fixture', loaded.frontMatter, loaded.body, undefined, loaded.sha);
  assert.deepEqual(parsePostContent(storedPost), {
    frontMatter: normalizeFrontMatter(parsed.frontMatter),
    body: parsed.body,
  });
  assert.equal(writes, 1);
  await createOrUpdatePost(
    context,
    'fixture',
    { title: 'x', category: 'null', description: 'undefined', cover: '[object Object]' },
    loaded.body,
  );
  const overlay = JSON.parse(bucket.get(CONTENT_OVERLAY_KEY)).upserts.fixture;
  assert.equal(overlay.category, null, 'overlay does not revive a cached category');
  assert.equal(overlay.description, null, 'overlay does not revive a cached description');
  assert.equal(overlay.cover, '', 'postRecord uses its usual empty-cover representation');
  globalThis.fetch = async () => {
    throw new Error('invalid payload reached GitHub');
  };
  for (const frontMatter of [
    { title: 42 },
    { title: 'x', date: 'invalid' },
    { title: 'x', custom: 'null' },
    { title: 'x', category: '..' },
  ]) {
    await assert.rejects(() => createOrUpdatePost(context, 'fixture', frontMatter, 'body'), invalidContent);
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log(`Frontmatter round-trip: ${validPosts} posts round-trip losslessly; edge cases and mocked saves passed`);
