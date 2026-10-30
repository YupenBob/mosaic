/**
 * R2 cloud drafts: create/get/list, optimistic revision, snapshots and delete.
 */
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';
import {
  createDraft,
  deleteDraft,
  getDraft,
  listDrafts,
  publishDraft,
  saveDraft,
} from '../worker/src/services/drafts.js';
import { DRAFT_ID_RE, draftRevisionKey } from '../shared/drafts.mjs';

const runtime = createRuntime();
const context = { env: runtime.env };

const created = await createDraft(context, {
  slug: 'draft-post',
  title: 'Draft title',
  body: 'Hello',
  frontMatter: { title: 'Draft title', category: 'Notes' },
  media: { gallery: ['ast_0123456789abcdefghjkmnpq'], videos: [], music: [], cover: null },
});
assert.match(created.id, DRAFT_ID_RE);
assert.equal(created.revision, 1);
assert.equal(created.title, 'Draft title');

const fetched = await getDraft(context, created.id);
assert.equal(fetched.body, 'Hello');
assert.equal(fetched.media.gallery.length, 1);

const saved = await saveDraft(context, created.id, {
  revision: 1,
  body: 'Hello again',
  title: 'Draft title v2',
  slug: 'draft-post',
  frontMatter: { title: 'Draft title v2' },
  media: fetched.media,
});
assert.equal(saved.revision, 2);
assert.equal(saved.body, 'Hello again');
assert.ok(await runtime.store.head(draftRevisionKey(created.id, 1)), 'previous revision is snapshotted');

await assert.rejects(
  () => saveDraft(context, created.id, { revision: 1, body: 'stale' }),
  (error) => error.status === 409 && error.code === 'CONFLICT',
);

const list = await listDrafts(context);
assert.equal(list.length, 1);
assert.equal(list[0].id, created.id);
assert.equal(list[0].revision, 2);
assert.equal(list[0].mediaCount, 1);

await assert.rejects(
  () => getDraft(context, 'drf_not-valid'),
  (error) => error.status === 400,
);
await deleteDraft(context, created.id);
await assert.rejects(
  () => getDraft(context, created.id),
  (error) => error.status === 404,
);
assert.equal((await listDrafts(context)).length, 0);

// Publish writes Git, marks dirty and removes the cloud draft.
const realFetch = globalThis.fetch;
let putPayload = null;
globalThis.fetch = async (url, init = {}) => {
  if (!init.method || init.method === 'GET') return new Response('not found', { status: 404 });
  putPayload = JSON.parse(init.body);
  return new Response(JSON.stringify({ content: { sha: 'new-sha' }, commit: { sha: 'commit-sha' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
try {
  const publishable = await createDraft(context, {
    slug: 'published-draft',
    title: 'Publish me',
    body: 'Published body',
    frontMatter: { title: 'Publish me' },
    baseSha: null,
  });
  const published = await publishDraft(context, publishable.id);
  assert.equal(published.slug, 'published-draft');
  assert.equal(published.sha, 'new-sha');
  assert.ok(putPayload?.sha === undefined, 'new posts are create-only');
  await assert.rejects(
    () => getDraft(context, publishable.id),
    (error) => error.status === 404,
  );
} finally {
  globalThis.fetch = realFetch;
}

console.log('Drafts API: create, save, revision conflict, list, delete and publish passed');
