/**
 * hls.js adapter: one place that constructs the engine and normalizes its
 * events/levels for the decode controller.
 *
 * Intent-gated by design: constructing the engine only wires events and
 * attaches the media element. `loadSource()` is called by the controller on an
 * explicit play intent, so an unplayed player performs zero HLS requests.
 *
 * Only the documented hls.js surface is used (`on`, `loadSource`, `attachMedia`,
 * `startLoad`, `stopLoad`, `recoverMediaError`, `destroy`, `levels`,
 * `loadLevel`/`nextLevel`/`autoLevelCapping`). Test doubles that stub
 * `window.Hls` therefore stay compatible.
 */
import { guessHeight, formatBitrate, tierLabel } from './tune.js';
import { playbackUrl } from './request.js';

/** Normalize `hls.levels` into the controller/quality-menu shape. */
export function readLevels(levels) {
  return (Array.isArray(levels) ? levels : []).map((level, index) => {
    const height = Number(level?.height) > 0 ? Number(level.height) : guessHeight(level?.bitrate);
    return {
      index,
      height,
      width: Number(level?.width) || 0,
      bitrate: Number(level?.bitrate) || 0,
      label: tierLabel(height),
      detail: formatBitrate(level?.bitrate),
    };
  });
}

/**
 * Construct and wire the hls.js engine (no network request yet).
 * @param {{
 *   video: HTMLVideoElement,
 *   options?: object,
 *   callbacks?: {
 *     onManifest?: (levels: object[]) => void,
 *     onLevelSwitched?: (data: object) => void,
 *     onMediaAttached?: () => void,
 *     onFragLoaded?: () => void,
 *     onError?: (data: object) => void,
 *   },
 * }} config
 * @returns {{hls: object, levels: () => object[], loadSource: (url: string) => void}}
 */
export function createHlsEngine({ video, options = {}, callbacks = {} }) {
  const Hls = typeof window !== 'undefined' ? window.Hls : undefined;
  if (!Hls) throw new Error('hls.js is not available');
  const report = (name, payload) => {
    try {
      callbacks[name]?.(payload);
    } catch (error) {
      console.error('[Video] hls callback failed:', error);
    }
  };
  const hls = new Hls({
    ...options,
    xhrSetup(xhr, requestUrl) {
      xhr.open('GET', playbackUrl(requestUrl), true);
    },
  });
  if (video) video._hls = hls;
  const listen = (event, handler) => {
    try {
      if (typeof hls.on === 'function') hls.on(event, handler);
    } catch {
      /* a partial test double may not support every event */
    }
  };
  listen('hlsManifestParsed', () => report('onManifest', readLevels(hls.levels)));
  listen('hlsLevelSwitched', (_event, data) => report('onLevelSwitched', data || {}));
  listen('hlsMediaAttached', () => report('onMediaAttached'));
  listen('hlsFragLoaded', () => report('onFragLoaded'));
  listen('hlsError', (_event, data) => report('onError', data || {}));
  try {
    if (typeof hls.attachMedia === 'function') hls.attachMedia(video);
  } catch (error) {
    report('onError', { fatal: true, type: 'mediaError', details: 'attachMedia', error });
  }
  return {
    hls,
    levels: () => readLevels(hls.levels),
    loadSource(url) {
      if (!url) return;
      try {
        hls.loadSource(playbackUrl(url));
      } catch (error) {
        report('onError', { fatal: true, type: 'otherError', details: 'loadSource', error });
      }
    },
  };
}

/** Tear an hls.js instance down without throwing into player flows. */
export function destroyHlsEngine(hls) {
  if (!hls) return;
  try {
    if (typeof hls.destroy === 'function') hls.destroy();
  } catch {
    /* already destroyed */
  }
}
