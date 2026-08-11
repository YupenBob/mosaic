/**
 * Pure helpers for the video compression pipeline (no ffmpeg / R2 / fs deps),
 * so tests/upload-logic-smoke.mjs can exercise the decision logic directly.
 */

export const ALL_RES = [
  { name: '4K', height: 2160, bw: 15000000, label: '3840x2160' },
  { name: '1080p', height: 1080, bw: 5000000, label: '1920x1080' },
  { name: '720p', height: 720, bw: 2000000, label: '1280x720' },
  { name: '480p', height: 480, bw: 800000, label: '854x480' },
  { name: '360p', height: 360, bw: 400000, label: '640x360' },
  { name: '240p', height: 240, bw: 250000, label: '426x240' },
];

/**
 * Tiers that apply to a source height, ascending (240p -> 4K) so a time-budget
 * cutoff leaves the cheapest playable tiers done first; expensive tiers are
 * simply deferred to the next build (per-tier resume).
 */
export function tierListFor(srcHeight, maxHeight = 1080) {
  return ALL_RES.filter((r) => r.height <= srcHeight && r.height <= maxHeight)
    .sort((a, b) => a.height - b.height)
    .map((r) => r.name);
}

/**
 * Compute normalized waveform peaks [0..1] for an audio track.
 * Pure helper (no ffmpeg/fs deps) so the decision logic stays unit-testable.
 *
 * @param {Int16Array|number[]} samples - mono 16-bit PCM samples
 * @param {number} [buckets] - number of output peaks (default 400)
 * @returns {number[]} amplitude peaks in [0..1]
 */
export function computeWaveformPeaks(samples, buckets = 400) {
  const peaks = new Array(buckets).fill(0);
  if (!samples || !samples.length) return peaks;
  const per = Math.max(1, Math.ceil(samples.length / buckets));
  for (let i = 0; i < buckets; i++) {
    let max = 0;
    const end = Math.min(samples.length, (i + 1) * per);
    for (let j = i * per; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks[i] = Math.min(1, max / 32768);
  }
  return peaks;
}

/**
 * Streaming-upload batch boundary: true once `completed` tiers of `total`
 * new tiers are done AND it is either a multiple of `after` or the last tier
 * (so a final partial batch is always flushed).
 */
export function uploadAfterN(completed, total, after = 1) {
  return completed > 0 && (completed % after === 0 || completed >= total);
}

export const BUDGET_RATIO = 0.85;

/** True when `elapsedMs` has reached `ratio` of the job timeout budget. */
export function budgetExceeded(elapsedMs, timeoutMinutes, ratio = BUDGET_RATIO) {
  return elapsedMs >= timeoutMinutes * 60 * 1000 * ratio;
}

/** True when every expected tier is already listed in the manifest. */
export function manifestComplete(manifest, expectedTiers) {
  if (!manifest || !Array.isArray(manifest.tiers)) return false;
  return expectedTiers.every((t) => manifest.tiers.includes(t));
}
