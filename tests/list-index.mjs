import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';
import { cacheFor } from '../worker/src/services/github-client.js';
import { listPosts } from '../worker/src/services/content.js';
const runtime = createRuntime();
await runtime.enqueue('fixture', 'clip.mp4');
assert.equal((await runtime.call('dirty-state')).contentDirty, false);
await runtime.bucket.put(
  'site-data/posts-index.json',
  JSON.stringify([{ slug: 'fixture', title: 'Fixture', tags: [] }]),
);
Object.assign(cacheFor(runtime.env), { config: runtime.config, configTime: Date.now() });
let cacheReads = 0,
  githubRequests = 0;
const get = runtime.bucket.get.bind(runtime.bucket),
  fetch = globalThis.fetch;
runtime.bucket.get = (key) => {
  if (key === 'site-data/posts-index.json') cacheReads++;
  return get(key);
};
globalThis.fetch = async () => {
  githubRequests++;
  throw new Error('Unexpected GitHub content request');
};
try {
  assert.equal((await listPosts({ env: runtime.env }))[0].slug, 'fixture');
  assert.equal((await listPosts({ env: runtime.env }))[0].slug, 'fixture');
  assert.equal(cacheReads, 1);
  assert.equal(githubRequests, 0, 'media-only dirty state must not fetch Markdown bodies');
  console.log(
    'Thin list: first read uses one index GET, repeated read uses memory, media-only updates issue zero GitHub requests',
  );
} finally {
  globalThis.fetch = fetch;
}
