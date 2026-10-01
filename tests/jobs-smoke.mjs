import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import app from '../worker/src/index.js';
import { createRuntime } from './helpers/runtime.mjs';
import { cleanupMedia } from '../scripts/media/cleanup.mjs';
import { protectedMediaKeys } from '../worker/src/services/media-references.js';
const runtime = createRuntime();
const { call, bucket } = runtime;
const queued = await runtime.enqueue('post', 'clip.mp4');
assert.equal(queued.status, 'pending');
assert.equal(
  (await runtime.enqueue('post', 'clip.mp4')).taskId,
  queued.taskId,
  'duplicate upload confirmation is idempotent',
);
runtime.restart();
const { job } = await call('claim', { runId: '1' });
const identity = { id: job.id, token: job.token, runId: job.runId };
await assert.rejects(
  call('publish', { ...identity, published: { sources: { '240p': 'processed/post/videos/missing.mp4' } } }),
  /Missing processed/,
);
const low = 'processed/post/videos/v1/240p.mp4';
await bucket.put(low, 'low');
await call('publish', { ...identity, published: { sources: { '240p': low } }, complete: false });
assert.equal((await call('state')).manifest.assets['post/videos/clip.mp4'].published.sources['240p'], low);
await call('complete', { ...identity, complete: false });
const resumed = (await call('claim', { runId: '2' })).job;
assert.equal(resumed.checkpoint.sources['240p'], low);
await assert.rejects(call('heartbeat', identity), /Stale task lease/);
const newer = await runtime.enqueue('post', 'clip.mp4', Buffer.from('new-source'));
assert.notEqual(newer.taskId, queued.taskId);
assert.equal(
  (await call('state')).manifest.assets['post/videos/clip.mp4'].published.sources['240p'],
  low,
  'replacement keeps published media',
);
await assert.rejects(call('complete', { id: resumed.id, token: resumed.token, runId: '2' }), /Stale task lease/);
await call('delete', { slug: 'post', filename: 'clip.mp4' });
assert.equal((await call('state')).manifest.assets['post/videos/clip.mp4'].status, 'deleted');
await assert.rejects(call('retry', { id: newer.taskId }), /superseded/);
const retry = await runtime.enqueue('post', 'photo.jpg');
for (let i = 0; i <= runtime.config.media.maxRetries; i++) {
  const next = (await call('claim', { runId: `retry-${i}` })).job;
  await call('failed', { id: next.id, token: next.token, runId: next.runId, error: 'upload failed' });
}
assert.equal((await call('state')).jobs.find((j) => j.id === retry.taskId).status, 'failed');
await call('retry', { id: retry.taskId });
assert.equal((await call('state')).jobs.find((j) => j.id === retry.taskId).status, 'pending');
const before = await call('build-begin', { runId: 'site-1', gitSha: 'sha-one' });
await call('dirty', { gitSha: 'sha-two' });
await call('build-done', { runId: 'site-1', token: before.token, success: true });
assert.ok((await call('state')).dirty.count > 0, 'old deployment must not clear newer edits');
const latest = await call('build-begin', { runId: 'site-2', gitSha: 'sha-two' });
await call('build-done', { runId: 'site-2', token: latest.token, success: true });
assert.equal((await call('state')).dirty.count, 0);
assert.equal(
  (await call('build-begin', { runId: 'site-2', gitSha: 'sha-two' })).manifest.revision,
  latest.mediaRevision,
  'begin retries return the same snapshot',
);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('GitHub offline');
};
try {
  await runtime.alarm();
  assert.match(runtime.persistent.get('state').lastDispatchError, /offline/);
  assert.ok(runtime.persistent.get('jobs:' + retry.taskId));
} finally {
  globalThis.fetch = originalFetch;
}
const makeInternal = async (body, signature = true) => {
  const raw = JSON.stringify(body),
    timestamp = String(Date.now());
  const sig = crypto.createHmac('sha256', runtime.env.PIPELINE_SECRET).update(`${timestamp}.${raw}`).digest('hex');
  return app.fetch(
    new Request('https://worker.test/api/internal/media/state', {
      method: 'POST',
      body: raw,
      headers: {
        'Content-Type': 'application/json',
        'X-Mosaic-Time': timestamp,
        'X-Mosaic-Signature': signature ? sig : '0'.repeat(64),
      },
    }),
    runtime.env,
  );
};
assert.equal((await makeInternal({})).status, 200);
assert.equal((await makeInternal({}, false)).status, 401);
const recovered = createRuntime(),
  put = recovered.bucket.put.bind(recovered.bucket);
recovered.bucket.put = async (key, ...args) => {
  if (key.startsWith('site-data/media-manifest')) throw new Error('R2 unavailable');
  return put(key, ...args);
};
const outbox = await recovered.enqueue('recover', 'clip.mp4');
assert.equal(outbox.status, 'pending');
recovered.restart();
assert.ok(
  (await recovered.call('state')).jobs.find((job) => job.id === outbox.taskId),
  'registration survives R2 publication failure',
);
recovered.bucket.put = put;
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(null, { status: 204 });
try {
  await recovered.alarm();
} finally {
  globalThis.fetch = previousFetch;
}
assert.equal(recovered.persistent.get('state').manifestPending, false);
const retained = createRuntime();
await retained.enqueue('retained', 'clip.mp4');
const retainedJob = (await retained.call('claim', { runId: 'retain' })).job;
const retainedKey = 'processed/retained/videos/old/240p.mp4';
await retained.bucket.put(retainedKey, 'old');
await retained.call('publish', {
  id: retainedJob.id,
  token: retainedJob.token,
  runId: 'retain',
  published: { sources: { '240p': retainedKey } },
  complete: true,
});
const deployed = await retained.call('build-begin', { runId: 'deployment', gitSha: 'sha' });
await retained.call('build-done', { runId: 'deployment', token: deployed.token, success: true });
await retained.call('delete', { slug: 'retained' });
assert.ok((await protectedMediaKeys(retained.env)).has(retainedKey), 'deletion cannot remove deployed objects');
const orphan = 'processed/retained/videos/orphan/240p.mp4';
await retained.bucket.put(orphan, 'orphan');
for (const key of [retainedKey, orphan]) retained.bucket.objects.get(key).uploaded = new Date(0);
assert.deepEqual(
  await cleanupMedia({ config: retained.config, state: await retained.call('state'), store: retained.store }),
  [orphan],
);
const timeout = createRuntime();
await timeout.enqueue('expired', 'clip.mp4');
const expired = (await timeout.call('claim', { runId: 'expired' })).job;
const persisted = timeout.persistent.get('jobs:' + expired.id);
persisted.lease.expiresAt = 0;
timeout.restart();
globalThis.fetch = async () => {
  throw new Error('offline');
};
try {
  await timeout.alarm();
} finally {
  globalThis.fetch = previousFetch;
}
assert.equal(
  (await timeout.call('state')).jobs.find((job) => job.id === expired.id).status,
  'pending',
  'expired leases resume automatically',
);
console.log(
  'Jobs smoke: persistence, idempotency, upload barriers, resume, replacement, deletion, retry limits, snapshots, dispatch failure and signed callbacks passed',
);
const gated = createRuntime();
gated.env.REQUIRE_MEDIA_MIGRATION = 'true';
await assert.rejects(gated.call('build-begin', { runId: 'premature', gitSha: 'sha' }), (error) => error.status === 503);
await gated.call('import', { config: gated.config, manifest: { schemaVersion: 1, revision: 0, assets: {} } });
assert.ok((await gated.call('build-begin', { runId: 'migrated', gitSha: 'sha' })).token);
const fresh = await gated.enqueue('new', 'clip.mp4', Buffer.from('newest'));
const staleImport = structuredClone((await gated.call('state')).manifest);
staleImport.assets['new/videos/clip.mp4'].status = 'pending';
staleImport.assets['new/videos/clip.mp4'].source.etag = 'stale';
await gated.call('import', { config: gated.config, manifest: staleImport });
assert.equal((await gated.call('state')).manifest.assets['new/videos/clip.mp4'].jobId, fresh.taskId);
await retained.bucket.delete(`site-data/media-manifests/${deployed.mediaRevision}.json`);
await assert.rejects(
  cleanupMedia({ config: retained.config, state: await retained.call('state'), store: retained.store }),
  /snapshot is missing/,
);
const scale = createRuntime();
await scale.call('jobs-list');
for (let i = 0; i < 1200; i++) {
  const id = `job-${String(i).padStart(5, '0')}`;
  scale.persistent.set(`jobs:${id}`, { id, status: 'failed', error: 'x'.repeat(400), config: scale.config });
}
scale.restart();
assert.equal((await scale.call('jobs-list')).jobs.length, 1200, 'all pages of persisted jobs are recovered');
assert.ok(Buffer.byteLength(JSON.stringify(scale.persistent.get('state'))) < 128 * 1024);
const changed = createRuntime();
await changed.enqueue('config', 'clip.mp4');
await changed.enqueue('config', 'photo.jpg');
const previousTasks = (await changed.call('state')).jobs.map((job) => job.id);
const changedConfig = structuredClone(changed.config);
changedConfig.videoQuality.crf = 30;
changedConfig.media.reconcileBatchSize = 1;
await changed.call('reconcile', { config: changedConfig });
changed.restart();
const priorHead = changed.bucket.head.bind(changed.bucket);
changed.bucket.head = async () => {
  throw new Error('Temporary R2 outage');
};
globalThis.fetch = async () => new Response(null, { status: 204 });
try {
  await changed.alarm();
  assert.ok(changed.persistent.get('state').reconcile, 'failed reconciliation stays queued');
  changed.bucket.head = priorHead;
  for (let i = 0; i < 3; i++) await changed.alarm();
} finally {
  globalThis.fetch = previousFetch;
}
const changedState = await changed.call('state');
assert.equal(changedState.jobs.length, 3, 'only changed video settings create a replacement task');
assert.equal(changedState.jobs.find((job) => job.id === previousTasks[0]).status, 'superseded');
assert.equal(changed.persistent.get('state').reconcile, null);
const cacheFailure = createRuntime();
await cacheFailure.call('dirty', { gitSha: 'content' });
const cacheBuild = await cacheFailure.call('build-begin', { runId: 'cache-failure', gitSha: 'content' });
await cacheFailure.call('build-done', {
  runId: 'cache-failure',
  token: cacheBuild.token,
  success: true,
  cachePublished: false,
});
assert.equal(
  (await cacheFailure.call('dirty-state')).contentDirty,
  true,
  'failed cache publication keeps GitHub fallback',
);
console.log(
  'Jobs migration gate, safe cleanup, 1200-record recovery, durable configuration reconciliation and cache failure passed',
);
const coverReplacement = createRuntime();
const oldCover = await coverReplacement.enqueue('cover', 'cover.jpg', Buffer.from('old'), { folder: 'covers' });
const newCover = await coverReplacement.enqueue('cover', 'cover.jpg', Buffer.from('new'));
assert.notEqual(newCover.taskId, oldCover.taskId);
const coverAssets = (await coverReplacement.call('state')).manifest.assets;
assert.equal(Object.keys(coverAssets).length, 1, 'legacy covers retain their identity when uploaded through photos');
assert.equal(coverAssets['cover/covers/cover.jpg'].source.key, 'originals/cover/photos/cover.jpg');
