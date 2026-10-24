/**
 * Unit tests for the Experience v2 media contract: interpolation config
 * validation + fingerprint compatibility, keepSource options, pure ffmpeg
 * filter construction, tier ordering/master playlists, admin job projections
 * and the persisted media-dispatch state machine (pure planner + driver with
 * fake I/O). No ffmpeg / R2 / Workers runtime required.
 *
 * Run: node tests/media-options-smoke.mjs (also imported by tests/jobs-smoke.mjs)
 */
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  mergeInterpolation,
  normalizeConfig,
  processingConfig,
  validateConfig,
  validateInterpolation,
} from '../shared/config.mjs';
import { fingerprint } from '../shared/media-manifest.mjs';
import {
  buildEncodeArgs,
  buildMasterPlaylist,
  buildVideoFilter,
  orderedTiers,
  processedTierList,
  resolveInterpolation,
} from '../scripts/media/video-filter.mjs';
import {
  isProcessedMode,
  normalizeJobOptions,
  parseKeepSource,
  publicJobView,
  resolveKeepSource,
  sourceRetentionEligible,
} from '../worker/src/jobs/media-options.mjs';
import { dispatchBackoffMs } from '../worker/src/jobs/media-dispatch.mjs';
import { isJobDue, failJob, expireLeases, nextTaskWakeAt } from '../worker/src/jobs/job-state.mjs';

const config = normalizeConfig({});
const checks = [];
/** @param {string} name @param {() => (void|Promise<void>)} fn */
async function check(name, fn) {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (error) {
    checks.push(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}

await check('config defaults expose interpolation/keepSource/theme/experience', () => {
  assert.deepEqual(DEFAULTS.videoQuality.interpolation, {
    enabled: false,
    fps: 60,
    mode: 'mci',
    mcMode: 'aobmc',
    meMode: 'bidir',
    vsbmc: true,
  });
  assert.equal(DEFAULTS.media.keepSourceFiles, true);
  assert.equal(config.theme, 'auto');
  assert.equal(config.themeMode.default, 'auto');
  assert.equal(config.experience.motion.spring, 'snappy');
  assert.deepEqual(validateConfig(config), []);
});

await check('legacy theme string maps to themeMode.default and mirrors theme', () => {
  const legacy = normalizeConfig({ theme: 'dark' });
  assert.equal(legacy.themeMode.default, 'dark');
  assert.equal(legacy.theme, 'dark');
  const modern = normalizeConfig({ themeMode: { default: 'light', accent: 'rose' } });
  assert.equal(modern.theme, 'light');
  assert.equal(modern.themeMode.accent, 'rose');
  // Partial new-style sections deep-merge with defaults.
  assert.equal(normalizeConfig({ experience: { card: { size: 'compact' } } }).experience.card.image, 'full');
});

await check('validateConfig rejects invalid Experience v2 enums/ranges', () => {
  const invalid = [
    { themeMode: { default: 'sepia' } },
    { themeMode: { accent: 'crimson' } },
    { themeMode: { showMenu: 'yes' } },
    { experience: { card: { size: 'huge' } } },
    { experience: { card: { image: 'crop' } } },
    { experience: { motion: { spring: 'wavy' } } },
    { experience: { modal: { enabled: 1 } } },
    { media: { keepSourceFiles: 'no' } },
    { videoQuality: { interpolation: { enabled: 'yes' } } },
    { videoQuality: { interpolation: { fps: 12 } } },
    { videoQuality: { interpolation: { fps: 60.5 } } },
    { videoQuality: { interpolation: { mode: 'warp' } } },
    { videoQuality: { interpolation: { mcMode: 'foo' } } },
    { videoQuality: { interpolation: { meMode: 'foo' } } },
    { videoQuality: { interpolation: { vsbmc: 'true' } } },
  ];
  for (const patch of invalid)
    assert.ok(validateConfig(normalizeConfig(patch)).length > 0, `expected error for ${JSON.stringify(patch)}`);
  assert.deepEqual(
    validateInterpolation({ enabled: true, fps: 60, mode: 'mci', mcMode: 'aobmc', meMode: 'bidir', vsbmc: false }),
    [],
  );
});

await check('processing fingerprint is byte-identical to the pre-interpolation pipeline', async () => {
  // Exactly what the previous processingConfig(config, 'videos') produced.
  const legacy = {
    video: {
      crf: 23,
      preset: 'veryfast',
      maxHeight: 1080,
      uploadAfterTiers: 1,
      fps: 30,
      audioBitrate: '128k',
      segmentSeconds: 6,
      posterSeconds: 1,
    },
    enabled: true,
    image: { placeholderWidth: 150, placeholderQuality: 30 },
  };
  assert.equal(await fingerprint(processingConfig(config, 'videos')), await fingerprint(legacy));
  // keepSourceFiles must never affect processing.
  assert.equal(
    await fingerprint(processingConfig(normalizeConfig({ media: { keepSourceFiles: false } }), 'videos')),
    await fingerprint(legacy),
  );
  // Disabled interpolation explicit in config is still fingerprint-neutral.
  assert.equal(
    await fingerprint(
      processingConfig(normalizeConfig({ videoQuality: { interpolation: { enabled: false, fps: 90 } } }), 'videos'),
    ),
    await fingerprint(legacy),
  );
  // Enabling interpolation (or changing it while enabled) invalidates the fingerprint.
  const enabled = await fingerprint(
    processingConfig(normalizeConfig({ videoQuality: { interpolation: { enabled: true } } }), 'videos'),
  );
  assert.notEqual(enabled, await fingerprint(legacy));
  assert.notEqual(
    enabled,
    await fingerprint(
      processingConfig(normalizeConfig({ videoQuality: { interpolation: { enabled: true, fps: 50 } } }), 'videos'),
    ),
  );
});

await check('mergeInterpolation/resolveInterpolation precedence and clamping', () => {
  const merged = mergeInterpolation({}, { fps: 50 });
  assert.equal(merged.enabled, true, 'an override implies enabling');
  assert.equal(merged.fps, 50);
  assert.equal(resolveInterpolation(config), null);
  assert.equal(resolveInterpolation(normalizeConfig({ videoQuality: { interpolation: { enabled: true } } })).fps, 60);
  const override = resolveInterpolation(config, { interpolation: { fps: 24, mode: 'blend' } });
  assert.equal(override.fps, 24);
  assert.equal(override.mode, 'blend');
  assert.equal(resolveInterpolation(config, { interpolation: { fps: 999 } }).fps, 120, 'defensive clamp');
});

await check('buildVideoFilter orders scale before minterpolate and keeps yuv420p even', () => {
  const interpolation = { enabled: true, fps: 60, mode: 'mci', mcMode: 'aobmc', meMode: 'bidir', vsbmc: true };
  assert.equal(
    buildVideoFilter({ tierHeight: 240, sourceHeight: 480, compressed: true, interpolation: null, fps: 30 }),
    'scale=-2:240,fps=30',
  );
  assert.equal(
    buildVideoFilter({ tierHeight: 240, sourceHeight: 480, compressed: true, interpolation, fps: 30 }),
    'scale=-2:240,minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1',
  );
  assert.equal(
    buildVideoFilter({ tierHeight: 480, sourceHeight: 480, compressed: false, interpolation, fps: 30 }),
    'scale=trunc(iw/2)*2:trunc(ih/2)*2,minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1',
  );
  assert.equal(
    buildVideoFilter({ tierHeight: 480, sourceHeight: 480, compressed: false, interpolation: null, fps: 30 }),
    '',
  );
});

await check('buildEncodeArgs produces copy vs single-pass interpolated encode', () => {
  const interpolation = { enabled: true, fps: 24, mode: 'mci', mcMode: 'vmm', meMode: 'epzs', vsbmc: false };
  const video = { crf: 23, preset: 'veryfast', fps: 30, audioBitrate: '128k' };
  assert.deepEqual(
    buildEncodeArgs({ config: video, tierHeight: 480, sourceHeight: 480, compressed: false, interpolation: null }),
    ['-c', 'copy'],
  );
  const args = buildEncodeArgs({
    config: video,
    tierHeight: 240,
    sourceHeight: 480,
    compressed: true,
    interpolation,
  });
  assert.deepEqual(args.slice(0, 2), [
    '-vf',
    'scale=-2:240,minterpolate=fps=24:mi_mode=mci:mc_mode=vmm:me_mode=epzs:vsbmc=0',
  ]);
  assert.ok(args.includes('-pix_fmt') && args.includes('yuv420p'), 'yuv420p is required');
  assert.ok(args.includes('-c:a') && args.includes('aac'), 'audio is preserved');
});

await check('tier ordering and immutable master playlist', () => {
  assert.deepEqual(orderedTiers({ '1080p': 1, '240p': 2, '360p': 3, source: 4 }), ['240p', '360p', '1080p', 'source']);
  assert.deepEqual(processedTierList({ sources: { '720p': 'k', '240p': 'k' } }), ['240p', '720p']);
  assert.deepEqual(processedTierList(null), []);
  const master = buildMasterPlaylist({
    prefix: 'processed/post/videos/gen',
    tiers: ['240p', 'source'],
    playlists: {
      '240p': 'processed/post/videos/gen/240p.m3u8',
      source: 'processed/post/videos/gen/source.m3u8',
    },
    width: 640,
    height: 480,
  });
  assert.ok(master.startsWith('#EXTM3U\n#EXT-X-VERSION:3\n'));
  assert.match(master, /BANDWIDTH=250000,RESOLUTION=320x240/);
  assert.match(master, /BANDWIDTH=250000,RESOLUTION=640x480/);
  assert.match(master, /240p\.m3u8/);
  assert.match(master, /source\.m3u8/);
});

await check('keepSource parsing/defaults/options normalization', () => {
  assert.equal(parseKeepSource(true), true);
  assert.equal(parseKeepSource('0'), false);
  assert.equal(parseKeepSource('false'), false);
  assert.equal(parseKeepSource(1), true);
  assert.equal(parseKeepSource(undefined), undefined);
  assert.equal(resolveKeepSource(undefined, config), true);
  assert.equal(resolveKeepSource(false, config), false);
  assert.equal(resolveKeepSource(undefined, normalizeConfig({ media: { keepSourceFiles: false } })), false);
  assert.deepEqual(normalizeJobOptions(undefined, config), { keepSource: true });
  assert.deepEqual(normalizeJobOptions({ keepSource: false }, config), { keepSource: false });
  const processed = normalizeJobOptions({
    sourceMode: 'processed',
    interpolation: { enabled: true, fps: 24 },
  });
  assert.equal(processed.sourceMode, 'processed');
  assert.equal(processed.interpolation.fps, 24);
  assert.deepEqual(normalizeJobOptions({ sourceMode: 'weird', interpolation: { fps: 12 } }), normalizeJobOptions({}));
});

await check('job projections + source retention eligibility', () => {
  const job = {
    id: 'job',
    assetId: 'post/videos/clip.mp4',
    folder: 'videos',
    generation: 'g1',
    status: 'running',
    options: { keepSource: false },
    source: { key: 'originals/post/videos/clip.mp4', etag: 'e', available: true },
    config: { huge: true },
    lease: { token: 't' },
  };
  const asset = { generation: 'g1', status: 'ready', published: { sources: {} }, source: { available: true } };
  const view = publicJobView(job, asset);
  assert.equal(view.config, undefined);
  assert.equal(view.lease, undefined);
  assert.deepEqual(view.options, { keepSource: false });
  assert.equal(view.sourceAvailable, true);
  assert.equal(view.sourceDeletedAt, null);
  assert.equal(view.published, true);
  assert.equal(isProcessedMode({ options: { sourceMode: 'processed' } }), true);
  assert.equal(isProcessedMode({}), false);
  assert.equal(sourceRetentionEligible(job, asset), true);
  assert.equal(sourceRetentionEligible({ ...job, options: { keepSource: true } }, asset), false);
  assert.equal(sourceRetentionEligible({ ...job, folder: 'photos' }, asset), false);
  assert.equal(sourceRetentionEligible(job, { ...asset, generation: 'g2' }), false);
  assert.equal(sourceRetentionEligible(job, { ...asset, source: { available: false } }), false);
  const deletedView = publicJobView(job, { ...asset, sourceDeletedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(deletedView.sourceDeletedAt, '2026-01-01T00:00:00.000Z');
});

await check('job-state: due/retry/lease expiry/alarm wake', () => {
  const now = 1_000_000;
  assert.equal(isJobDue({ status: 'pending' }, now), true);
  assert.equal(isJobDue({ status: 'pending', nextAt: now + 1 }, now), false);
  assert.equal(isJobDue({ status: 'running' }, now), false);
  const job = { status: 'running', attempts: 0 };
  const media = { maxRetries: 3, retryMs: 1000 };
  assert.equal(failJob(job, 'x', media, now), 'pending');
  assert.equal(job.nextAt, now + 1000);
  assert.equal(failJob(job, 'x', media, now), 'pending');
  assert.equal(job.nextAt, now + 2000);
  assert.equal(failJob(job, 'x', media, now), 'pending');
  assert.equal(failJob(job, 'x', media, now), 'failed');
  const state = {
    jobs: { a: { status: 'running', lease: { expiresAt: now - 1 }, assetId: 'a' } },
    manifest: { assets: { a: { status: 'running' } } },
  };
  assert.equal(expireLeases(state, now, media), true);
  assert.equal(state.jobs.a.status, 'pending');
  assert.equal(state.manifest.assets.a.status, 'pending');
  assert.equal(nextTaskWakeAt({ jobs: {} }, config, now), 0);
  const wake = nextTaskWakeAt({ jobs: { a: { status: 'pending', nextAt: now + 5000 } } }, config, now);
  assert.equal(wake, now + 5000);
  assert.equal(nextTaskWakeAt({ jobs: { a: { status: 'pending' } } }, config, now), now + config.media.debounceMs);
  assert.equal(nextTaskWakeAt({ jobs: { a: { status: 'running' } } }, config, now), now + config.media.pollMs);
});

await check('dispatch backoff is exponential and capped', () => {
  const media = normalizeConfig({}).media;
  assert.equal(dispatchBackoffMs(1, { media }), media.retryMs);
  assert.equal(dispatchBackoffMs(2, { media }), media.retryMs * 2);
  assert.equal(dispatchBackoffMs(3, { media }), media.retryMs * 4);
  assert.ok(dispatchBackoffMs(50, { media }) <= 15 * 60 * 1000);
});

console.log(checks.join('\n'));
console.log(`\nMedia options smoke: ${checks.length} groups passed`);
