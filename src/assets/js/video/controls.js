/**
 * Player constants and tiny formatting helpers shared by the player modules.
 * Everything is read lazily from `window.__MOSAIC_CONFIG` so Node tests can
 * import the modules before mocking the browser globals.
 */

export const DEFAULT_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Playback speeds offered by the speed menu (config.player.speeds). */
export function getSpeeds() {
  const speeds = typeof window !== 'undefined' ? window.__MOSAIC_CONFIG?.player?.speeds : null;
  return Array.isArray(speeds) && speeds.length ? speeds : DEFAULT_SPEEDS;
}

/** Published tier display order (config.player.qualityOrder). */
export function getQualityOrder() {
  const order = typeof window !== 'undefined' ? window.__MOSAIC_CONFIG?.player?.qualityOrder : null;
  return Array.isArray(order) && order.length ? order : ['4K', '1080p', '720p', '480p', '360p', '240p'];
}

/**
 * `m:ss` / `h:mm:ss` clock format for the progress bar.
 * @param {number} seconds
 */
export function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
