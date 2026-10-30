/**
 * Media v2 upload API: presign → direct R2 PUT → complete → asset task.
 * Uses a fake Hono context and the in-memory Jobs DO runtime.
 */
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';
import { newAssetId } from '../shared/media-v2.mjs';
import { completeAssetUpload, generatePresignedUrl } from '../worker/src/r2.js';

const runtime = createRuntime();
Object.assign(runtime.env, {
  GITHUB_TOKEN: 'fixture',
  R2_ENDPOINT: 'https://fixture.r2.cloudflarestorage.com',
  R2_ACCESS_KEY: 'fixture-access',
  R2_SECRET_KEY: 'fixture-secret',
});

// getConfig must not hit the network in this fixture.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('not found', { status: 404 });

function context(body, params = {}) {
  return {
    env: runtime.env,
    req: {
      json: async () => body,
      param: (name) => params[name],
      query: () => '',
      header: () => '',
    },
    json: (value, status = 200) => ({ value, status }),
  };
}

try {
  const id = newAssetId();
  const presigned = await generatePresignedUrl(context({ filename: 'clip.mp4', contentType: 'video/mp4' }), {
    assetId: id,
    filename: 'clip.mp4',
    contentType: 'video/mp4',
  });
  const created = presigned.value;
  assert.equal(presigned.status, 200);
  assert.ok(created.url, JSON.stringify(created));
  assert.ok(created.assetId, 'presign returns an independent asset id');
  assert.equal(created.key, `originals/assets/${created.assetId}/clip.mp4`);
  assert.match(created.url, /^https:\/\/fixture\.r2\.cloudflarestorage\.com\//, 'direct R2 URL');
  assert.equal(created.folder, 'videos');

  // Simulate the browser's direct PUT.
  await runtime.bucket.put(created.key, Buffer.from('video-bytes'));
  const completedResponse = await completeAssetUpload(context({ filename: 'clip.mp4' }, { id: created.assetId }));
  const completed = completedResponse.value;
  assert.equal(completed.assetId, created.assetId);
  assert.ok(completed.taskId);
  assert.equal(completed.status, 'pending');

  const listed = await runtime.call('assets-list', {});
  assert.equal(listed.total, 1);
  assert.equal(listed.assets[0].id, created.assetId);
  assert.equal(listed.assets[0].status, 'pending');
  assert.equal(listed.assets[0].v2, true);

  const missing = await completeAssetUpload(context({ filename: 'missing.mp4' }, { id: created.assetId }));
  assert.equal(missing.status, 404, 'complete verifies the object exists');

  console.log('Assets API: presign, direct PUT, complete and list passed');
} finally {
  globalThis.fetch = realFetch;
}
