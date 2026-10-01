import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { runProcess } from '../scripts/media/process.mjs';
import { processTask } from '../scripts/media/run.mjs';
import { migrateLegacy } from '../scripts/media/legacy.mjs';
import { createRuntime } from './helpers/runtime.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-media-test-'));
try {
  await runProcess('ffmpeg', ['-version']);
  const runtime = createRuntime();
  const request = (operation, body) => runtime.call(operation.split('/')[1], body);
  const photo = path.join(root, 'fixture.jpg');
  await sharp({ create: { width: 96, height: 64, channels: 3, background: '#6688aa' } })
    .withMetadata({ exif: { IFD0: { Artist: 'Private fixture metadata' } } })
    .jpeg()
    .toFile(photo);
  assert.ok((await sharp(photo).metadata()).exif, 'privacy test source must contain EXIF');
  await runtime.enqueue('post', '照片.jpg', fs.readFileSync(photo));
  let job = (await runtime.call('claim', { runId: 'photos' })).job;
  assert.equal(await processTask(job, { request, store: runtime.store, workRoot: root }), true);
  const asset = (await runtime.call('state')).manifest.assets['post/photos/照片.jpg'];
  assert.equal(asset.status, 'ready');
  assert.ok(asset.published.variants['480p']);
  const sanitized = runtime.bucket.objects.get(asset.published.original);
  assert.ok(!(await sharp(sanitized.body).metadata()).exif, 'published originals must strip EXIF');
  const clip = path.join(root, 'fixture.mp4');
  await runProcess('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=640x480:r=10:d=0.5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.5',
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-y',
    clip,
  ]);
  await runtime.enqueue('post', 'clip.mp4', fs.readFileSync(clip));
  job = (await runtime.call('claim', { runId: 'low' })).job;
  let lowPublished = false;
  const cutoff = job.config.media.timeoutMinutes * 60000;
  const progressiveRequest = async (operation, body) => {
    const result = await request(operation, body);
    if (operation === 'media/publish') lowPublished = true;
    return result;
  };
  assert.equal(
    await processTask(job, {
      request: progressiveRequest,
      store: runtime.store,
      workRoot: root,
      now: () => (lowPublished ? cutoff : 0),
    }),
    false,
  );
  let video = (await runtime.call('state')).manifest.assets['post/videos/clip.mp4'];
  assert.deepEqual(
    Object.keys(video.published.sources),
    ['240p'],
    'first playable tier is published before high tiers',
  );
  const firstMaster = video.published.hls;
  job = (await runtime.call('claim', { runId: 'high' })).job;
  assert.equal(await processTask(job, { request, store: runtime.store, workRoot: root }), true);
  video = (await runtime.call('state')).manifest.assets['post/videos/clip.mp4'];
  assert.equal(Object.keys(video.published.sources).length, 3);
  assert.notEqual(video.published.hls, firstMaster, 'adding tiers creates a new immutable master');
  assert.ok(runtime.bucket.objects.has(firstMaster), 'old deployments retain their master');
  const audio = path.join(root, 'fixture.flac');
  await runProcess('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.3',
    '-metadata',
    'title=Fixture Music',
    '-y',
    audio,
  ]);
  await runtime.enqueue('post', 'music.flac', fs.readFileSync(audio));
  job = (await runtime.call('claim', { runId: 'music' })).job;
  assert.equal(await processTask(job, { request, store: runtime.store, workRoot: root }), true);
  const music = (await runtime.call('state')).manifest.assets['post/music/music.flac'];
  assert.equal(music.published.waveform.length, 400);
  assert.equal(music.published.title, 'Fixture Music');
  await runtime.enqueue('post', 'fail.jpg', fs.readFileSync(photo));
  job = (await runtime.call('claim', { runId: 'fail' })).job;
  const failing = {
    ...runtime.store,
    upload: async () => {
      throw new Error('simulated upload failure');
    },
  };
  await assert.rejects(processTask(job, { request, store: failing, workRoot: root }), /simulated upload failure/);
  assert.equal((await runtime.call('state')).manifest.assets['post/photos/fail.jpg'].published, null);
  await runtime.call('cancel', { id: job.id });
  await runtime.enqueue('post', 'budget.mp4', fs.readFileSync(clip));
  job = (await runtime.call('claim', { runId: 'budget' })).job;
  assert.equal(
    await processTask(job, { request, store: runtime.store, workRoot: root, deadline: Date.now() - 1 }),
    false,
  );
  const deferred = (await runtime.call('state')).jobs.find((task) => task.id === job.id);
  assert.equal(deferred.status, 'pending');
  assert.equal(deferred.attempts, 0, 'budget continuation does not consume failure retries');
  // A legacy playlist with a missing segment is never imported as playable.
  const legacy = createRuntime();
  await legacy.bucket.put('originals/post/videos/clip.mp4', 'source');
  await legacy.bucket.put('processed/post/videos/clip-240p.mp4', 'mp4');
  await legacy.bucket.put('processed/post/videos/clip-240p.m3u8', '#EXTM3U\nmissing.ts\n');
  const migrated = await migrateLegacy(legacy.store, legacy.config, {
    '__video__/post/clip': JSON.stringify({ tiers: ['240p'], height: 480 }),
  });
  assert.equal(migrated.assets['post/videos/clip.mp4'].published, null);
  console.log(
    'Media integration: real image/video/audio processing, privacy, progressive publish, resume, immutable masters, upload failure and legacy object validation passed',
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
