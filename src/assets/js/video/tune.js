/**
 * Player tuning helpers shared by the decode controller and the player UI.
 *
 * Everything in this module is pure or reads platform capabilities lazily, so it
 * is safe to import from Node tests after mocking `window`/`navigator`.
 *
 * Adaptive policy (smoothness without losing explicit config):
 * - `config.player.hls` from `window.__MOSAIC_CONFIG` always wins for keys it
 *   defines. Adaptive constraints only ever *lower* buffer/timeout budgets for
 *   constrained devices (low memory, Save-Data, 2G), so an operator who sets
 *   `maxBufferLength: 12` keeps 12.
 * - `autoStartLoad` is forced to `false`: network decoding must be started by an
 *   explicit play intent, never by attaching a player.
 */

export const QUALITY_STORAGE_KEY = 'mosaic_video_quality';

/** Player section of the injected site config (empty object when absent). */
export function playerConfig() {
  if (typeof window === 'undefined') return {};
  return window.__MOSAIC_CONFIG?.player || {};
}

/** Default hls.js options coming from `shared/config.mjs` through the template. */
export function hlsConfig() {
  return playerConfig().hls || {};
}

/** Network Information API record (Chrome/Android); empty object elsewhere. */
export function connectionInfo() {
  if (typeof navigator === 'undefined') return {};
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
}

/**
 * Aggregate what this device/network can comfortably decode.
 * @returns {{memory:number|undefined,cores:number|undefined,saveData:boolean,slowNetwork:boolean,lowMemory:boolean,reducedMotion:boolean,effectiveType:string,dpr:number,width:number}}
 */
export function deviceProfile() {
  const connection = connectionInfo();
  const memory = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  const saveData = connection.saveData === true;
  const effectiveType = connection.effectiveType || '';
  const slowNetwork =
    /^(slow-2g|2g|3g)$/.test(effectiveType) || (Number(connection.downlink) > 0 && connection.downlink < 1.5);
  const lowMemory = Number.isFinite(memory) ? memory <= 2 : Number.isFinite(cores) ? cores <= 2 : false;
  const reducedMotion =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
  return {
    memory,
    cores,
    saveData,
    slowNetwork,
    lowMemory,
    reducedMotion,
    effectiveType,
    dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    width: typeof window !== 'undefined' ? window.innerWidth || 1280 : 1280,
  };
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Merge the operator hls.js config with adaptive constraints.
 * `autoStartLoad` is always false; fragments only load after play intent.
 * @param {object} [base] operator config (`config.player.hls`)
 * @param {{profile?:ReturnType<typeof deviceProfile>,lowNetwork?:boolean}} [options]
 * @returns {object} hls.js constructor options
 */
export function buildHlsConfig(base = hlsConfig(), options = {}) {
  const profile = options.profile || deviceProfile();
  const config = { ...base };
  const constrained = options.lowNetwork || profile.saveData || profile.slowNetwork;
  if (constrained) {
    config.maxBufferLength = Math.min(numberOr(config.maxBufferLength, 20), profile.saveData ? 12 : 20);
    config.maxMaxBufferLength = Math.min(numberOr(config.maxMaxBufferLength, 60), 30);
    config.backBufferLength = Math.min(numberOr(config.backBufferLength, 30), 10);
    config.abrEwmaDefaultEstimate = Math.min(numberOr(config.abrEwmaDefaultEstimate, 1000000), 700000);
    config.startFragPrefetch = false;
  } else if (profile.lowMemory) {
    config.maxBufferLength = Math.min(numberOr(config.maxBufferLength, 30), 30);
    config.maxMaxBufferLength = Math.min(numberOr(config.maxMaxBufferLength, 60), 60);
    config.backBufferLength = Math.min(numberOr(config.backBufferLength, 30), 15);
  }
  if (!Number.isInteger(config.startLevel)) config.startLevel = 0;
  config.autoStartLoad = false;
  return config;
}

/** Height in pixels for a published tier label (`'480p'`, `'4K'`, `720`). */
export function tierHeight(label) {
  if (label == null) return 0;
  const text = String(label).trim();
  if (/^4k$/i.test(text)) return 2160;
  const match = /(\d{3,4})/.exec(text.replace(/p$/i, ''));
  return match ? Number(match[1]) : 0;
}

/** Canonical published tier label for a pixel height (`3840` is rendered as `4K`). */
export function tierLabel(height) {
  const value = Number(height) || 0;
  if (value >= 2160) return '4K';
  return value > 0 ? `${value}p` : 'auto';
}

/** Infer a height from a bitrate when the manifest omits RESOLUTION. */
export function guessHeight(bitrate) {
  const value = Number(bitrate) || 0;
  if (value > 12000000) return 2160;
  if (value > 6000000) return 1440;
  if (value > 3000000) return 1080;
  if (value > 1500000) return 720;
  if (value > 700000) return 480;
  if (value > 350000) return 360;
  return 240;
}

/** Human readable bitrate for the quality menu (`2.5 Mbps`, `800 kbps`). */
export function formatBitrate(bps) {
  const value = Number(bps);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1000000) return `${(value / 1000000).toFixed(1).replace(/\.0$/, '')} Mbps`;
  return `${Math.round(value / 1000)} kbps`;
}

/**
 * Normalize `sources` (tier -> url) into ascending-quality tiers.
 * @param {Record<string,string>} [sources]
 * @returns {Array<{label:string,url:string,height:number}>}
 */
export function sortTiers(sources = {}) {
  return Object.entries(sources || {})
    .filter(([label, url]) => label !== 'single' && typeof url === 'string' && url)
    .map(([label, url]) => ({ label, url, height: tierHeight(label) }))
    .sort((a, b) => a.height - b.height);
}

/**
 * Pick the progressive-MP4 start tier.
 * `startLevel` follows `config.player.hls.startLevel`: 0 = lowest published tier,
 * positive = that index, -1 = auto by viewport/device profile.
 * @param {Array<{label:string,height:number}>} tiers ascending
 * @param {{startLevel?:number,profile?:object,lowNetwork?:boolean}} [options]
 */
export function pickStartTier(tiers, options = {}) {
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const profile = options.profile || deviceProfile();
  const startLevel = options.startLevel;
  if (options.lowNetwork || profile.saveData || profile.slowNetwork) return tiers[0];
  if (Number.isInteger(startLevel) && startLevel >= 0) return tiers[Math.min(startLevel, tiers.length - 1)];
  let target = profile.width * profile.dpr;
  if (profile.lowMemory) target = Math.min(target, 720);
  return tiers.find((tier) => tier.height >= target) || tiers[tiers.length - 1];
}

/** Index of the hls level matching a tier label/height, or -1. */
export function findLevelIndex(levels, wanted) {
  if (!Array.isArray(levels) || !levels.length || wanted == null) return -1;
  const height = tierHeight(wanted);
  const exact = levels.findIndex((level) => level.label === wanted || (height > 0 && level.height === height));
  return exact;
}

/** Nearest level index at or above the requested height, else the highest level. */
export function nearestLevelIndex(levels, wanted) {
  if (!Array.isArray(levels) || !levels.length) return -1;
  const exact = findLevelIndex(levels, wanted);
  if (exact >= 0) return exact;
  const height = tierHeight(wanted);
  const above = levels.findIndex((level) => level.height >= height);
  return above >= 0 ? above : levels.length - 1;
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** Persisted manual quality choice (`'auto'` or a tier label) or null. */
export function readStoredQuality() {
  try {
    return storage()?.getItem(QUALITY_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** Persist the manual quality choice; storage failures never break playback. */
export function storeQuality(value) {
  try {
    storage()?.setItem(QUALITY_STORAGE_KEY, String(value));
  } catch {
    /* private mode / quota */
  }
}

/**
 * Resolve the manual quality preference for a fresh player.
 * Explicit per-player `preference` wins over the persisted choice; `'auto'` or an
 * unavailable tier resolves to null (automatic adaptation).
 * @param {Array<{label:string}>} tiers
 * @param {string} [preference]
 * @returns {string|null} tier label
 */
export function resolveManualQuality(tiers, preference) {
  const wanted = preference != null ? preference : readStoredQuality();
  if (!wanted || /^auto$/i.test(String(wanted))) return null;
  const label = String(wanted);
  const match = (tiers || []).find(
    (tier) => tier.label === label || (tier.height > 0 && tier.height === tierHeight(label)),
  );
  return match ? match.label : null;
}
