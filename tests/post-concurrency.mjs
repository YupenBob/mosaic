/**
 * Post save concurrency: `baseSha` must prevent silent last-write-wins.
 * Uses a mocked GitHub Contents API; no network or credentials.
 */
import assert from 'node:assert/strict';
import { createOrUpdatePost } from '../worker/src/services/content.js';

const context = {
  env: { GITHUB_REPO: 'fixture/mosaic', SITE_BRANCH: 'main', GITHUB_TOKEN: 'fixture' },
};

const body = '---\ntitle: Fixture\n---\n\nBody';
const content = Buffer.from(body, 'utf8').toString('base64');
let calls = [];

function mockFetch() {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (method === 'GET') {
      return new Response(JSON.stringify({ content, sha: 'old-sha' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    calls.push({ method, payload: JSON.parse(init.body) });
    return new Response(JSON.stringify({ commit: { sha: 'commit-sha' }, content: { sha: 'new-sha' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

mockFetch();
await assert.rejects(
  () => createOrUpdatePost(context, 'fixture', { title: 'X' }, 'body', 'msg', 'stale-sha'),
  (error) => error.status === 409 && error.code === 'CONFLICT',
  'stale baseSha must conflict',
);
assert.equal(calls.length, 0, 'a conflict must not write to GitHub');

mockFetch();
await assert.rejects(
  () => createOrUpdatePost(context, 'fixture', { title: 'X' }, 'body', 'msg', null),
  (error) => error.status === 409 && error.code === 'SLUG_CONFLICT',
  'creating over an existing slug must conflict',
);
assert.equal(calls.length, 0, 'a slug conflict must not write to GitHub');

mockFetch();
const result = await createOrUpdatePost(context, 'fixture', { title: 'X' }, 'body', 'msg', 'old-sha');
assert.equal(result.content.sha, 'new-sha');
assert.equal(calls.length, 1, 'matching baseSha writes once');
assert.equal(calls[0].payload.sha, 'old-sha', 'the write carries the loaded blob SHA');

mockFetch();
await assert.rejects(
  () => createOrUpdatePost(context, `x');alert(1)//`, { title: 'X' }, 'body'),
  (error) => error.status === 400 && error.code === 'INVALID_PARAMS',
  'unsafe slugs are rejected before any request',
);
assert.equal(calls.length, 0);

// Legacy callers that omit baseSha keep working.
mockFetch();
await createOrUpdatePost(context, 'fixture', { title: 'X' }, 'body', 'legacy');
assert.equal(calls.length, 1, 'omitted baseSha keeps the legacy write path');

console.log('Post concurrency: baseSha conflict, slug conflict and unsafe slug passed');
