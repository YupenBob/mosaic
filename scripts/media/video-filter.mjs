/**
 * Pure video encoding decisions for the media pipeline: optical-flow
 * interpolation settings, ffmpeg filter/argument construction, tier ordering
 * and HLS master playlists. No ffmpeg, filesystem or R2 dependencies, so the
 * logic is unit-testable (`tests/media-options-smoke.mjs`).
 */
import { ALL_RES } from '../media-utils.mjs';
import { mergeInterpolation } from '../../shared/config.mjs';

/** Fallback bandwidth for tiers unknown to ALL_RES (e.g. legacy "source"). */
const DEFAULT_BANDWIDTH = 250000;

/**
 * Resolve the effective interpolation settings for a job.
 *
 * Precedence: `options.interpolation` (per-job override, used by post-hoc
 * interpolation) > `config.videoQuality.interpolation`. Interpolation is only
 * active when explicitly enabled; requesting an override enables it by default.
 *
 * @param {object} config - normalized site config
 * @param {{interpolation?: object}} [options] - job options
 * @returns {null|{enabled:true, fps:number, mode:string, mcMode:string, meMode:string, vsbmc:boolean}}
 */
export function resolveInterpolation(config, options = {}) {
  const base = config?.videoQuality?.interpolation || {};
  const override = options?.interpolation;
  if (!override && base.enabled !== true) return null;
  const merged = mergeInterpolation(base, override);
  if (merged.enabled !== true) return null;
  // Defensive clamp: config/API are validated, but old persisted jobs are not.
  merged.fps = Math.min(120, Math.max(24, Math.round(Number(merged.fps) || 60)));
  return merged;
}

/**
 * ffmpeg `minterpolate` filter expression for motion-compensated interpolation.
 * @param {{fps:number, mode:string, mcMode:string, meMode:string, vsbmc:boolean}} interpolation
 * @returns {string}
 */
export function minterpolateFilter(interpolation) {
  return [
    `minterpolate=fps=${interpolation.fps}`,
    `mi_mode=${interpolation.mode}`,
    `mc_mode=${interpolation.mcMode}`,
    `me_mode=${interpolation.meMode}`,
    `vsbmc=${interpolation.vsbmc ? 1 : 0}`,
  ].join(':');
}

/**
 * Build the `-vf` chain for one output tier. Scale precedes interpolation so
 * optical flow runs at the cheap tier resolution; when no resize is needed the
 * chain still normalizes to even dimensions (yuv420p requires them).
 *
 * @param {object} options
 * @param {number} options.tierHeight - target tier height (source height when not compressing)
 * @param {boolean} options.compressed - whether the plugin resizes/compresses
 * @param {object|null} options.interpolation - resolved interpolation or null
 * @param {number} options.fps - configured fallback frame rate
 * @returns {string} comma-separated filter chain ('' means none)
 */
export function buildVideoFilter({ tierHeight, compressed, interpolation, fps }) {
  const filters = [];
  if (compressed) {
    filters.push(`scale=-2:${tierHeight}`);
  } else if (interpolation) {
    // Keep the source resolution but guarantee even dimensions for yuv420p.
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  }
  if (interpolation) filters.push(minterpolateFilter(interpolation));
  else if (compressed) filters.push(`fps=${fps}`);
  return filters.join(',');
}

/**
 * Build the ffmpeg encoding arguments for one tier (everything between `-i`
 * and `-map_metadata`). Returns `['-c', 'copy']` when no re-encode is needed.
 *
 * @param {object} options
 * @param {object} options.config - normalized videoQuality config
 * @param {number} options.tierHeight
 * @param {boolean} options.compressed
 * @param {object|null} options.interpolation - resolved interpolation or null
 * @returns {string[]}
 */
export function buildEncodeArgs({ config, tierHeight, compressed, interpolation }) {
  if (!compressed && !interpolation) return ['-c', 'copy'];
  const args = [];
  const filter = buildVideoFilter({
    tierHeight,
    compressed,
    interpolation,
    fps: config.fps,
  });
  if (filter) args.push('-vf', filter);
  args.push('-c:v', 'libx264', '-crf', String(config.crf), '-preset', config.preset);
  if (interpolation) args.push('-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', config.audioBitrate);
  return args;
}

/**
 * Order published tier keys for processing: cheapest (lowest) first so a time
 * budget cuts only expensive tiers, unknown/legacy names last alphabetically.
 * @param {Record<string, unknown>} sources - published `sources` map
 * @returns {string[]}
 */
export function orderedTiers(sources = {}) {
  // ALL_RES is descending (4K -> 240p); rank by ascending height.
  const rank = new Map([...ALL_RES].reverse().map((resolution, index) => [resolution.name, index]));
  return Object.keys(sources).sort((a, b) => {
    const left = rank.has(a) ? rank.get(a) : ALL_RES.length;
    const right = rank.has(b) ? rank.get(b) : ALL_RES.length;
    return left - right || a.localeCompare(b, 'en');
  });
}

/**
 * Tiers a processed-mode re-encode must reproduce: the tiers already published
 * for the asset (never upscale/invent new ones).
 * @param {object} published - asset.published
 * @returns {string[]}
 */
export function processedTierList(published) {
  return orderedTiers(published?.sources || {});
}

/**
 * Relative HLS playlist reference from a published prefix.
 * @param {string} prefix - `processed/<slug>/<folder>/<generation>`
 * @param {string} key - published playlist key
 * @returns {string} URL-safe relative reference
 */
export function relativePlaylist(prefix, key) {
  const base = `${prefix.replace(/\/+$/, '')}/`;
  const relative = key.startsWith(base) ? key.slice(base.length) : key.split('/').pop();
  return relative.split('/').map(encodeURIComponent).join('/');
}

/**
 * Build an immutable HLS master playlist for the currently published tiers.
 * @param {object} options
 * @param {string} options.prefix - published object prefix
 * @param {string[]} options.tiers - published tier names, ascending
 * @param {Record<string, string>} options.playlists - tier -> published playlist key
 * @param {number} options.width - source video width in px
 * @param {number} options.height - source video height in px
 * @returns {string} m3u8 content
 */
export function buildMasterPlaylist({ prefix, tiers, playlists, width, height }) {
  const aspect = width && height ? width / height : 0;
  const lines = tiers.map((tier) => {
    const resolution = ALL_RES.find((entry) => entry.name === tier);
    const tierResolution =
      tier === 'source' || !resolution
        ? `${width}x${height}`
        : `${Math.round((aspect * resolution.height) / 2) * 2}x${resolution.height}`;
    return `#EXT-X-STREAM-INF:BANDWIDTH=${resolution?.bw || DEFAULT_BANDWIDTH},RESOLUTION=${tierResolution}\n${relativePlaylist(prefix, playlists[tier])}\n`;
  });
  return `#EXTM3U\n#EXT-X-VERSION:3\n${lines.join('')}`;
}
