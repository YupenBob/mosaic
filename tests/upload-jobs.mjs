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
  const get = async (route, authToken) => {
    const response = await app.fetch(
      new Request(`https://worker.test/api${route}`, {
        headers: { ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
      }),
      runtime.env,
    );
    return { status: response.status, result: await response.json() };
  };
  // ── keepSource transport: direct = query/header (raw body), JSON = body field ──
  const directKeep = await call('/upload/direct/post/direct-keep.mp4?keepSource=0', 'video-bytes', token, true);
  assert.equal(directKeep.keepSource, false);
  const headerKeepResponse = await app.fetch(
    new Request('https://worker.test/api/upload/direct/post/header-keep.mp4', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Bearer ${token}`,
        'X-Mosaic-Keep-Source': '1',
      },
      body: 'video-bytes',
    }),
    runtime.env,
  );
  assert.equal(headerKeepResponse.status, 200);
  const headerKeep = await headerKeepResponse.json();
  assert.equal(headerKeep.keepSource, true);
  const presignedKeep = await call('/upload/presign', { slug: 'post', filename: 'keep.mp4', keepSource: false }, token);
  assert.equal(presignedKeep.keepSource, false);
  await runtime.bucket.put('originals/post/videos/keep.mp4', 'video');
  const keepComplete = await call('/upload/complete/post/keep.mp4', { keepSource: false }, token);
  assert.equal(keepComplete.keepSource, false);
  await runtime.bucket.put('originals/post/videos/multi-keep.mp4', 'multipart');
  const multiKeep = await call(
    '/upload/multipart/complete',
    { slug: 'post', filename: 'multi-keep.mp4', uploadId: start.uploadId, keepSource: false },
    token,
  );
  assert.equal(multiKeep.keepSource, false);
  const jobs = await get('/media-jobs', token);
  assert.equal(jobs.status, 200);
  const optionsFor = (assetId) => jobs.result.jobs.find((job) => job.assetId === assetId).options;
  assert.equal(optionsFor('post/videos/direct-keep.mp4').keepSource, false);
  assert.equal(optionsFor('post/videos/header-keep.mp4').keepSource, true);
  assert.equal(optionsFor('post/videos/keep.mp4').keepSource, false);
  assert.equal(optionsFor('post/videos/multi-keep.mp4').keepSource, false);
  assert.equal(optionsFor('post/videos/multi-keep.mp4').sourceMode, undefined);
  // ── post-hoc interpolation endpoint (needs an already decoded video) ──
  await runtime.enqueue('post', 'decoded.mp4', Buffer.from('decoded-source'));
  let decodedJob;
  for (let attempt = 0; attempt < 20 && !decodedJob; attempt++) {
    const claimed = (await runtime.call('claim', { runId: `seed-${attempt}` })).job;
    if (!claimed) break;
    if (claimed.assetId === 'post/videos/decoded.mp4') decodedJob = claimed;
  }
  assert.ok(decodedJob, 'decoded fixture task must be claimable');
  const publishedKey = 'processed/post/videos/seed/240p.mp4';
  await runtime.bucket.put(publishedKey, 'tier');
  await runtime.call('publish', {
    id: decodedJob.id,
    token: decodedJob.token,
    runId: decodedJob.runId,
    published: { sources: { '240p': publishedKey } },
    complete: true,
  });
  await runtime.call('complete', {
    id: decodedJob.id,
    token: decodedJob.token,
    runId: decodedJob.runId,
    complete: true,
  });
  const probe = await get('/media/interpolate', token);
  assert.equal(probe.status, 200);
  assert.equal(probe.result.supported, true);
  assert.equal(probe.result.defaults.fps, 60);
  const interpolate = await call('/media/interpolate', { slug: 'post' }, token);
  assert.equal(interpolate.enqueued, 1);
  assert.equal(interpolate.tasks[0].assetId, 'post/videos/decoded.mp4');
  assert.ok(
    interpolate.skipped.some((entry) => entry.assetId === 'post/videos/multi.mp4' && entry.reason === 'not-decoded'),
    'undecoded videos are skipped, not queued',
  );
  const repeatInterpolate = await call('/media/interpolate', { slug: 'post' }, token);
  assert.equal(repeatInterpolate.enqueued, 0);
  assert.ok(repeatInterpolate.skipped.some((entry) => entry.reason === 'already-queued'));
  const processed = (await runtime.call('jobs-list')).jobs.find(
    (job) => job.assetId === 'post/videos/decoded.mp4' && job.options.sourceMode === 'processed',
  );
  assert.equal(processed.options.interpolation.enabled, true);
  assert.equal(processed.options.interpolation.fps, 60);
  assert.equal((await get('/media/interpolate')).result.error, 'Unauthorized');
  console.log(
    'Upload jobs: Worker direct, presigned PUT and multipart completion register durable tasks with keepSource options; duplicate confirmations, interpolation enqueueing and capability probe passed',
  );
} finally {
  globalThis.fetch = originalFetch;
}
