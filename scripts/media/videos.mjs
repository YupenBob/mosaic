/**
 * Video tier orchestration: probe, poster, per-tier transcode (optionally with
 * optical-flow frame interpolation), HLS segmentation and progressive publish.
 *
 * Two source modes are supported:
 * - `original` (default): transcode the downloaded `originals/...` source.
 * - `processed`: re-encode + re-segment the already published tier MP4s
 *   (post-hoc interpolation; works even after originals were deleted).
 *
 * Every tier's MP4, fragments and playlist are uploaded and HEAD-verified by
 * the coordinator before the checkpoint becomes visible; the HLS master is
 * immutable per published tier set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ALL_RES, tierListFor } from '../media-utils.mjs';
import { buildEncodeArgs, buildMasterPlaylist, processedTierList, resolveInterpolation } from './video-filter.mjs';
import { cleanupTierFiles, encodeTier, extractPoster, probeVideo, segmentFiles, segmentTier } from './video-source.mjs';
import { writeWebpPreview } from './preview.mjs';

/**
 * @param {object} options
 * @param {string} options.source - local original file ('' in processed mode)
 * @param {string} options.directory - job temp directory
 * @param {object} options.job - claimed job (config + options + checkpoint)
 * @param {object} options.store - media storage adapter
 * @param {string} options.prefix - published object prefix for this generation
 * @param {(published: object, complete: boolean, sanitized?: boolean, extra?: object) => Promise<void>} options.publish
 * @param {() => boolean} options.budgetExceeded
 * @param {AbortSignal} options.signal
 * @param {object|null} [options.published] - previously published asset (processed mode)
 * @returns {Promise<boolean>} true when every target tier is published
 */
export async function processVideo({
  source,
  directory,
  job,
  store,
  prefix,
  publish,
  budgetExceeded,
  signal,
  published = null,
}) {
  const options = job.options || {};
  const processedMode = options.sourceMode === 'processed';
  const interpolation = resolveInterpolation(job.config, options);
  const config = job.config.videoQuality;
  const compressed = job.config.plugins['compress-videos']?.enabled !== false;

  // ── Resolve inputs (processed mode streams published tier MP4s, never originals) ──
  let firstInput;
  let targets;
  let processedSources = null;
  if (processedMode) {
    // Prefer the snapshot captured at enqueue time: a budget-interrupted partial
    // publish replaces asset.published, so `published.sources` may only list the
    // tiers already re-encoded while the remaining inputs live in the old generation.
    processedSources =
      job.processedSources && Object.keys(job.processedSources).length
        ? job.processedSources
        : published?.sources || {};
    targets = processedTierList({ sources: processedSources });
    if (!targets.length) throw new Error('Processed source has no published tiers to interpolate');
    firstInput = path.join(directory, `input-${targets[0]}.mp4`);
    await store.download(processedSources[targets[0]], firstInput, null, { signal });
  } else {
    firstInput = source;
  }
  const info = await probeVideo(firstInput, { signal });
  if (!processedMode) targets = compressed ? tierListFor(info.height, config.maxHeight) : ['source'];
  if (!targets.length) targets.push('source');

  const output = {
    ...job.checkpoint,
    sources: { ...job.checkpoint.sources },
    playlists: { ...job.checkpoint.playlists },
    segments: { ...job.checkpoint.segments },
    duration: info.duration,
    aspect: info.aspect,
  };
  const posterFile = path.join(directory, 'poster.jpg');
  const posterAt = Math.max(0, Math.min(config.posterSeconds, output.duration / 2));
  if (!output.poster || !(await store.head(output.poster))) {
    await extractPoster({ input: firstInput, output: posterFile, at: posterAt, signal });
    output.poster = await store.upload(`${prefix}/poster.jpg`, posterFile);
  }
  // Few-KB card preview (LQIP). Additive published field; legacy assets simply
  // fall back to the poster until they are re-processed.
  if (!output.posterPreview || !(await store.head(output.posterPreview))) {
    if (!fs.existsSync(posterFile)) await store.download(output.poster, posterFile, null, { signal });
    const previewFile = path.join(directory, 'poster-preview.webp');
    await writeWebpPreview({
      input: posterFile,
      output: previewFile,
      width: job.config.media.image.placeholderWidth,
      quality: job.config.media.image.placeholderQuality,
    });
    output.posterPreview = await store.upload(`${prefix}/poster-preview.webp`, previewFile);
  }

  let changed = false;
  let completed = 0;
  let sourceRetentionSent = false;
  /** Publish current checkpoint; every referenced object is HEAD-verified by the coordinator. */
  const commit = async () => {
    const tiers = Object.keys(output.sources);
    if (!tiers.length) return;
    const revision = tiers.join('-');
    const masterFile = path.join(directory, 'master.m3u8');
    fs.writeFileSync(
      masterFile,
      buildMasterPlaylist({ prefix, tiers, playlists: output.playlists, width: info.width, height: info.height }),
    );
    output.hls = await store.upload(`${prefix}/master-${revision}.m3u8`, masterFile);
    const complete = targets.every((tier) => output.sources[tier]);
    // Keep-source consent is forwarded once, with the final fully published tier set.
    const extra =
      complete && !sourceRetentionSent && job.options?.keepSource === false && job.source?.available !== false
        ? { sourceRetained: false }
        : {};
    await publish(output, complete, false, extra);
    if (extra.sourceRetained === false) sourceRetentionSent = true;
    changed = false;
  };

  for (const tier of targets) {
    if (
      output.sources[tier] &&
      output.playlists[tier] &&
      (
        await Promise.all(
          [output.sources[tier], output.playlists[tier], ...(output.segments[tier] || [])].map((key) =>
            store.head(key),
          ),
        )
      ).every(Boolean)
    )
      continue;
    if (budgetExceeded()) break;
    const resolution = ALL_RES.find((entry) => entry.name === tier);
    const tierHeight = resolution?.height || info.height;
    const localInput =
      processedMode && tier !== targets[0]
        ? await downloadTier(store, processedSources, tier, directory, signal)
        : firstInput;
    // A processed tier is re-encoded from a same-size already-published MP4;
    // legacy "source" tiers stay at the probed resolution.
    const tierCompressed = processedMode ? !!resolution : compressed;
    const args = buildEncodeArgs({ config, tierHeight, compressed: tierCompressed, interpolation });
    const file = path.join(directory, `${tier}.mp4`);
    await encodeTier({
      input: localInput,
      output: file,
      args,
      timeoutMs: job.config.media.timeoutMinutes * 60000,
      signal,
    });
    if (processedMode && localInput !== firstInput) fs.rmSync(localInput, { force: true });
    const playlist = path.join(directory, `${tier}.m3u8`);
    await segmentTier({
      input: file,
      playlist,
      segmentPattern: path.join(directory, `${tier}-%05d.ts`),
      segmentSeconds: config.segmentSeconds,
      signal,
    });
    const segments = [];
    for (const name of segmentFiles(directory, tier))
      segments.push(await store.upload(`${prefix}/${name}`, path.join(directory, name)));
    output.playlists[tier] = await store.upload(`${prefix}/${tier}.m3u8`, playlist);
    output.sources[tier] = await store.upload(`${prefix}/${tier}.mp4`, file);
    output.segments[tier] = segments;
    changed = true;
    completed++;
    if (processedMode) cleanupTierFiles(directory, tier);
    if (completed % config.uploadAfterTiers === 0) await commit();
  }
  if (changed || !job.checkpoint.hls) await commit();
  return targets.every((tier) => output.sources[tier]);
}

/**
 * Download one already-published tier MP4 for re-encoding.
 * @param {object} store
 * @param {Record<string, string>} sources - tier -> published object key (enqueue-time snapshot)
 * @param {string} tier
 * @param {string} directory
 * @param {AbortSignal} signal
 * @returns {Promise<string>} local path
 */
async function downloadTier(store, sources, tier, directory, signal) {
  const file = path.join(directory, `input-${tier}.mp4`);
  await store.download(sources[tier], file, null, { signal });
  return file;
}
