import assert from 'node:assert/strict';
import app from '../worker/src/index.js';
import { createRuntime } from './helpers/runtime.mjs';
import { encodeBase64 } from '../worker/src/services/github-client.js';
const runtime = createRuntime();
Object.assign(runtime.env, {
  ADMIN_PASSWORD: 'fixture-password',
  JWT_SECRET: 'f'.repeat(64),
  CF_ACCOUNT_ID: 'fixture-account',
  R2_ACCESS_KEY: 'fixture-access',
  R2_SECRET_KEY: 'fixture-secret',
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const address = new URL(url);
  if (address.hostname === 'api.github.com')
    return Response.json({ content: encodeBase64(JSON.stringify(runtime.config)) });
  if (address.searchParams.has('uploads')) return new Response('<UploadId>fixture-upload</UploadId>');
  if (options.method === 'GET')
    return new Response(
      '<ListPartsResult><Part><PartNumber>1</PartNumber><Size>10</Size><ETag>&quot;etag&quot;</ETag></Part></ListPartsResult>',
    );
  await runtime.bucket.put('originals/post/videos/multi.mp4', 'multipart');
  return new Response('<CompleteMultipartUploadResult/>');
};
try {
  const call = async (route, body, token, raw = false) => {
    const response = await app.fetch(
      new Request(`https://worker.test/api${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': raw ? 'application/octet-stream' : 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: raw ? body : JSON.stringify(body || {}),
      }),
      runtime.env,
    );
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const { token } = await call('/auth/login', { password: 'fixture-password' });
  const direct = await call('/upload/direct/post/photo.jpg', 'image', token, true);
  assert.equal(direct.status, 'pending');
  assert.ok(direct.taskId);
  const presign = await call('/upload/presign', { slug: 'post', filename: 'track.flac' }, token);
  assert.match(presign.url, /X-Amz-Signature/);
  await runtime.bucket.put('originals/post/music/track.flac', 'audio');
  const confirmed = await call('/upload/complete/post/track.flac', {}, token);
  const duplicate = await call('/upload/complete/post/track.flac', {}, token);
  assert.equal(confirmed.taskId, duplicate.taskId);
  assert.equal(duplicate.duplicate, true);
  const start = await call('/upload/multipart/start', { slug: 'post', filename: 'multi.mp4', size: 10 }, token);
  const multi = await call(
    '/upload/multipart/complete',
    { slug: 'post', filename: 'multi.mp4', uploadId: start.uploadId },
    token,
  );
  const repeated = await call(
    '/upload/multipart/complete',
    { slug: 'post', filename: 'multi.mp4', uploadId: start.uploadId },
    token,
  );
  assert.ok(multi.taskId);
  assert.equal(repeated.taskId, multi.taskId);
  assert.equal(repeated.duplicate, true);
  assert.equal((await runtime.call('state')).jobs.length, 3);
  runtime.restart();
  assert.equal((await runtime.call('state')).jobs.length, 3, 'batch uploads persist before dispatch');
  console.log(
    'Upload jobs: Worker direct, presigned PUT and multipart completion register durable tasks; duplicate confirmations and batches are idempotent',
  );
} finally {
  globalThis.fetch = originalFetch;
}
