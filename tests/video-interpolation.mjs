/**
 * FFmpeg integration test for Experience v2 video frame interpolation.
 *
 * Proves, with a synthetic source and real ffmpeg/ffprobe:
 * 1. config-enabled interpolation during a normal transcode produces a tier MP4
 *    with a higher fps than the source, yuv420p, even dimensions and audio.
 * 2. `processed`-mode post-hoc interpolation re-encodes the already published
 *    tier MP4s into a NEW generation with no original source present at all.
 * 3. keepSource=false deletes the original only after the final verified publish
 *    and marks `source.available=false` + `sourceDeletedAt`; published outputs
 *    (mp4/HLS fragments/playlist/master/poster) stay intact and HEAD-verifiable.
 *
 * Requires ffmpeg 4.4+ on PATH. Run: node tests/video-interpolation.mjs
 * (wired into `npm run test:media`; `npm run check` never needs ffmpeg).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from './helpers/runtime.mjs';
import { processTask } from '../scripts/media/run.mjs';
import { runProcess } from '../scripts/media/process.mjs';
import { processingConfig } from '../shared/config.mjs';
import { fingerprint } from '../shared/media-manifest.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-interpolation-test-'));
const FPS = 10;
const DURATION = 0.4;

/**
 * @param {object} store
 * @param {string} key
 * @param {string} name
 * @returns {Promise<{fps:string, fpsValue:number, pix:string, width:number, height:number, audio:boolean}>}
 */
async function probePublished(store, key, name) {
  const object = await store.get(key);
  const file = path.join(root, `${name}.mp4`);
  fs.writeFileSync(file, Buffer.from(await new Response(object.body).arrayBuffer()));
  const info = JSON.parse(
    (await runProcess('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { capture: true })).toString(),
  );
  const stream = info.streams.find((entry) => entry.codec_type === 'video');
  const [numerator, denominator] = String(stream.r_frame_rate).split('/').map(Number);
  return {
    fps: stream.r_frame_rate,
    fpsValue: numerator / (denominator || 1),
    pix: stream.pix_fmt,
    width: stream.width,
    height: stream.height,
    audio: info.streams.some((entry) => entry.codec_type === 'audio'),
  };
}

/** Assert every published object of an asset exists in R2 (the DO HEAD-verifies these). */
async function assertPublishedObjects(asset, bucket) {
  assert.ok(asset.published, 'asset must be published');
  assert.ok(asset.published.poster, 'poster is published');
  assert.ok(asset.published.hls, 'master playlist is published');
  for (const [tier, key] of Object.entries(asset.published.sources)) {
    assert.ok(key.endsWith(`/${tier}.mp4`), `tier ${tier} mp4 key`);
    assert.ok(await bucket.head(key), `tier ${tier} mp4 exists`);
    assert.ok(asset.published.playlists[tier], `tier ${tier} playlist is published`);
    assert.ok(await bucket.head(asset.published.playlists[tier]), `tier ${tier} playlist exists`);
    assert.ok(asset.published.segments[tier].length > 0, `tier ${tier} has HLS fragments`);
    for (const segment of asset.published.segments[tier])
      assert.ok(await bucket.head(segment), `tier ${tier} fragment exists: ${segment}`);
    const playlist = await (await bucket.get(asset.published.playlists[tier])).text();
    assert.match(playlist, /#EXTM3U/, 'playlist is an m3u8');
  }
  assert.ok(await bucket.head(asset.published.poster), 'poster exists');
  assert.ok(await bucket.head(asset.published.hls), 'master playlist exists');
}

try {
  await runProcess('ffmpeg', ['-version']);
  const clip = path.join(root, 'source.mp4');
  await runProcess('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=320x240:r=${FPS}:d=${DURATION}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${DURATION}`,
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
  // ── 1. config-enabled interpolation during a normal transcode + keepSource=false ──
  const runtime = createRuntime();
  runtime.config.videoQuality.interpolation = {
    ...runtime.config.videoQuality.interpolation,
    enabled: true,
    fps: 24,
    mode: 'mci',
    mcMode: 'aobmc',
    meMode: 'bidir',
    vsbmc: true,
  };
  const request = (operation, body) => runtime.call(operation.split('/')[1], body);
  await runtime.enqueue('interp', 'clip.mp4', fs.readFileSync(clip), { options: { keepSource: false } });
  const job = (await runtime.call('claim', { runId: 'original' })).job;
  assert.equal(job.options.keepSource, false);
  assert.equal(await processTask(job, { request, store: runtime.store, workRoot: root }), true);
  let state = await runtime.call('state');
  let asset = state.manifest.assets['interp/videos/clip.mp4'];
  assert.equal(asset.status, 'ready');
  await assertPublishedObjects(asset, runtime.bucket);
  const interpolated = await probePublished(runtime.store, asset.published.sources['240p'], 'interpolated-original');
  assert.ok(interpolated.fpsValue > FPS, `interpolated fps ${interpolated.fps} must exceed source ${FPS}fps`);
  assert.equal(interpolated.fpsValue, 24, 'output fps follows the configured interpolation fps');
  assert.equal(interpolated.pix, 'yuv420p');
  assert.equal(interpolated.width % 2, 0, 'even width');
  assert.equal(interpolated.height % 2, 0, 'even height');
  assert.equal(interpolated.audio, true, 'audio track is preserved');
  assert.equal(asset.source.available, false, 'keepSource=false releases the original');
  assert.ok(asset.sourceDeletedAt, 'source deletion is timestamped');
  assert.equal(runtime.bucket.objects.has('originals/interp/videos/clip.mp4'), false, 'original object deleted');

  // ── 2. processed-mode post-hoc interpolation with originals gone + budget resume ──
  const tallClip = path.join(root, 'tall.mp4');
  await runProcess('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=640x480:r=${FPS}:d=${DURATION}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${DURATION}`,
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
    tallClip,
  ]);
  const posthoc = createRuntime();
  const postRequest = (operation, body) => posthoc.call(operation.split('/')[1], body);
  await posthoc.enqueue('posthoc', 'tall.mp4', fs.readFileSync(tallClip));
  const firstJob = (await posthoc.call('claim', { runId: 'decode' })).job;
  assert.equal(await processTask(firstJob, { request: postRequest, store: posthoc.store, workRoot: root }), true);
  state = await posthoc.call('state');
  const decoded = state.manifest.assets['posthoc/videos/tall.mp4'];
  const decodedGeneration = decoded.generation;
  assert.deepEqual(Object.keys(decoded.published.sources).sort(), ['240p', '360p', '480p']);
  const decodedProbe = await probePublished(posthoc.store, decoded.published.sources['240p'], 'decoded');
  assert.equal(decodedProbe.fpsValue, 30, 'default transcode keeps its configured fps');
  // The original disappears (e.g. an earlier keepSource=false run or manual cleanup).
  await posthoc.bucket.delete('originals/posthoc/videos/tall.mp4');
  const baseConfig = posthoc.config;
  const effective = structuredClone(baseConfig);
  effective.videoQuality.interpolation = { ...baseConfig.videoQuality.interpolation, enabled: true, fps: 48 };
  const enqueued = await posthoc.call('interpolate', {
    all: false,
    slug: 'posthoc',
    filename: '',
    config: effective,
    stateConfig: baseConfig,
    configHash: await fingerprint(processingConfig(baseConfig, 'videos')),
  });
  assert.equal(enqueued.enqueued, 1, 'post-hoc interpolation task is registered');
  // First run stops at the media budget after one tier (progressive publish/resume).
  let posthocClaim = await posthoc.call('claim', { runId: 'posthoc-budget' });
  assert.equal(posthocClaim.job.options.sourceMode, 'processed');
  assert.ok(posthocClaim.published, 'published tiers are delivered to the runner');
  assert.deepEqual(
    Object.keys(posthocClaim.job.processedSources).sort(),
    ['240p', '360p', '480p'],
    'the runner snapshots every published tier at enqueue time',
  );
  let publishedCount = 0;
  const requestCountingPublishes = async (operation, body) => {
    const result = await postRequest(operation, body);
    if (operation === 'media/publish') publishedCount++;
    return result;
  };
  const budgetCutoff = posthoc.config.media.timeoutMinutes * 60000;
  assert.equal(
    await processTask(posthocClaim.job, {
      request: requestCountingPublishes,
      store: posthoc.store,
      workRoot: root,
      published: posthocClaim.published,
      now: () => (publishedCount ? budgetCutoff : 0),
    }),
    false,
    'budget interruption returns incomplete without failing the task',
  );
  state = await posthoc.call('state');
  let partial = state.manifest.assets['posthoc/videos/tall.mp4'];
  assert.deepEqual(Object.keys(partial.published.sources), ['240p'], 'low tier is published before the budget exit');
  // Retry/resume: the second runner continues the remaining tiers from the old generation snapshot.
  posthocClaim = await posthoc.call('claim', { runId: 'posthoc-resume' });
  assert.equal(
    await processTask(posthocClaim.job, {
      request: postRequest,
      store: posthoc.store,
      workRoot: root,
      published: posthocClaim.published,
    }),
    true,
  );
  state = await posthoc.call('state');
  asset = state.manifest.assets['posthoc/videos/tall.mp4'];
  assert.notEqual(asset.generation, decodedGeneration, 'post-hoc interpolation creates a new generation');
  assert.deepEqual(
    Object.keys(asset.published.sources).sort(),
    ['240p', '360p', '480p'],
    'resume completes every tier',
  );
  await assertPublishedObjects(asset, posthoc.bucket);
  const reprocessed = await probePublished(posthoc.store, asset.published.sources['240p'], 'posthoc');
  assert.ok(
    reprocessed.fpsValue > decodedProbe.fpsValue,
    `post-hoc fps ${reprocessed.fpsValue} must exceed decoded ${decodedProbe.fpsValue}`,
  );
  assert.equal(reprocessed.fpsValue, 48);
  assert.equal(reprocessed.pix, 'yuv420p');
  assert.equal(reprocessed.audio, true);
  for (const tier of ['360p', '480p']) {
    const probe = await probePublished(posthoc.store, asset.published.sources[tier], `posthoc-${tier}`);
    assert.equal(probe.fpsValue, 48, `${tier} is interpolated on resume`);
  }
  // The previous generation stays readable until the manifest switches.
  assert.ok(await posthoc.bucket.head(decoded.published.sources['240p']), 'old published tier is retained');
  console.log(
    `Video interpolation: config-enabled transcode ${interpolated.fps} (source ${FPS}fps, keepSource released original), post-hoc processed mode ${reprocessed.fps} without originals, budget-interrupted resume, new generation + HLS/HEAD contract passed`,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
