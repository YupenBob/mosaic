/**
 * Unified video decode-flow controller (HLS via hls.js, native HLS, progressive MP4).
 *
 * This is the single decode path in the codebase: the post-page player and the
 * feed overlay both create their media through `createPlayback()`.
 *
 * State machine:
 *   idle -> attaching -> loading -> ready <-> playing <-> stalled
 *                     \-> recovering -> fallback -> ready/playing/destroyed
 *
 * Decode-flow rules (the root fix for "the first click does nothing"):
 * 1. Attaching a player performs ZERO media requests (poster only): no manifest,
 *    no playlist, no fragment. `autoStartLoad: false` is forced and even
 *    `loadSource()` waits for an explicit intent.
 * 2. `play()` records an explicit intent; if the media element/manifest is not
 *    ready yet the intent is replayed on the next readiness event, so the first
 *    click cannot be swallowed by the MSE attach race.
 * 3. Every fatal-error / destroy / pagehide path funnels through one recovery
 *    routine; hls.js instances are never duplicated for the same element.
 * 4. Position restore happens once metadata exists, under a stable
 *    `mosaic_video_pos_<media id>` key (never the transient MSE blob URL).
 *
 * Events (`on(name, callback)` returns an unsubscribe function): `statechange`,
 * `ready`, `levels`, `loading`, `playing`, `paused`, `stalled`, `downgrade`,
 * `blocked`, `recovering`, `fallback`, `levelchange`, `switching`, `restored`,
 * `seek`, `timeupdate`, `volumechange`, `seeking`, `seeked`, `ended`, `error`,
 * `destroyed`, `playintent`.
 */
import { canUseMse, ensureHlsLoaded, hasHlsJs, nativeHlsSupported } from './hls-loader.js';
import { deviceProfile, pickStartTier, playerConfig, resolveManualQuality, sortTiers, storeQuality } from './tune.js';
import { flow } from './flow.js';
import { mediaEvents } from './media-events.js';

export { ensureHlsLoaded, hlsVendorUrl, nativeHlsSupported } from './hls-loader.js';

const POSITION_PREFIX = 'mosaic_video_pos_';
const prefetchedOrigins = new Set();

/**
 * Warm the media origin only on an explicit playback intent. Nothing is
 * requested at attach time, so unplayed players cost zero network bytes.
 * @param {Array<string|undefined>} urls
 */
function hintMedia(urls) {
  if (typeof document === 'undefined' || typeof location === 'undefined') return;
  for (const value of urls) {
    if (!value) continue;
    let url;
    try {
      url = new URL(value, document.baseURI);
    } catch {
      continue;
    }
    if (url.origin === location.origin || prefetchedOrigins.has(url.origin)) continue;
    prefetchedOrigins.add(url.origin);
    for (const rel of ['preconnect', 'dns-prefetch']) {
      try {
        const link = document.createElement('link');
        link.rel = rel;
        link.href = url.origin;
        if (rel === 'preconnect') link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
      } catch {
        /* no head (SSR/test) */
      }
    }
  }
}

/**
 * Build one decode controller for a `<video>` element.
 * One controller per element: repeated calls return the live instance, and a
 * destroyed controller is never resurrected.
 * @param {{
 *   video: HTMLVideoElement,
 *   hls?: string,
 *   sources?: Record<string, string>,
 *   poster?: string,
 *   muted?: boolean,
 *   startLevel?: number,
 *   lowNetwork?: boolean,
 *   preload?: 'none'|'metadata'|'auto',
 *   mediaId?: string,
 *   positionKey?: string,
 *   resume?: boolean,
 *   quality?: string,
 *   container?: HTMLElement,
 * }} options
 * @returns {Playback}
 */
export function createPlayback(options = {}) {
  const video = options.video;
  if (!video || typeof video.play !== 'function') throw new TypeError('createPlayback requires a video element');
  const existing = video.__mosaicPlayback;
  if (existing && !existing.destroyed) return existing;
  return new Playback(video, options);
}

/** Decode controller returned by {@link createPlayback}. */
class Playback {
  constructor(video, options) {
    this.video = video;
    this.options = options || {};
    this.container = this.options.container || video.closest?.('.video-container') || null;
    this._state = 'idle';
    this._mode = 'idle'; // idle | hls | native | mp4
    this._destroyed = false;
    this._attached = false;
    this._events = new Map();
    this._timers = new Map();
    this._abort = typeof AbortController === 'function' ? new AbortController() : null;
    this._hls = null;
    this._engine = null;
    this._levels = [];
    this._manifestStarted = false;
    this._manifestReady = false;
    this._sources = { ...(this.options.sources || {}) };
    this._hlsUrl = this.options.hls || '';
    this._profile = deviceProfile();
    this._startLevel = Number.isInteger(this.options.startLevel)
      ? this.options.startLevel
      : Number.isInteger(playerConfig().hls?.startLevel)
        ? playerConfig().hls.startLevel
        : 0;
    this._manual = null;
    this._progressive = null;
    this._currentLevel = null;
    this._playIntent = false;
    this._attemptingPlay = false;
    this._retryCount = 0;
    this._loadStarted = false;
    this._fatalCount = 0;
    this._fallbackStarted = false;
    this._restored = false;
    this._pendingSeek = null;
    this._pendingQuality = null;
    this._switchToken = 0;
    this._resumeOnVisible = false;
    this._lastPersist = 0;
    this._stallStart = 0;
    this.mediaId = this.options.mediaId || video.dataset?.mediaId || this._deriveMediaId();
    this.positionKey = this.options.positionKey || POSITION_PREFIX + this.mediaId;
    video.__mosaicPlayback = this;
  }

  // ---- introspection ------------------------------------------------------

  get state() {
    return this._state;
  }

  get mode() {
    return this._mode;
  }

  get hls() {
    return this._hls;
  }

  get element() {
    return this.video;
  }

  get destroyed() {
    return this._destroyed;
  }

  get quality() {
    return this._manual || 'auto';
  }

  get levels() {
    return this._levels;
  }

  getLevels() {
    return this._levels.slice();
  }

  getQuality() {
    return this._manual || 'auto';
  }

  /**
   * Subscribe to a controller event.
   * @param {string} event
   * @param {(payload: object) => void} callback
   * @returns {() => void} unsubscribe
   */
  on(event, callback) {
    if (typeof callback !== 'function') return () => {};
    const set = this._events.get(event) || new Set();
    set.add(callback);
    this._events.set(event, set);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    this._events.get(event)?.delete(callback);
  }

  // ---- public decode-flow surface ----------------------------------------

  /**
   * Wire sources/capabilities. Idempotent and request-free: no manifest and no
   * fragment is fetched here. hls.js (when needed) is fetched so the engine can
   * attach, but decoding starts only from {@link play} or {@link prewarm}.
   */
  attach() {
    if (this._attached || this._destroyed) return this;
    this._attached = true;
    const video = this.video;
    try {
      if (!video.crossOrigin && (this._hlsUrl || Object.keys(this._sources).length)) video.crossOrigin = 'anonymous';
      if (this.options.poster && !video.getAttribute?.('poster')) video.poster = this.options.poster;
      if (this.options.muted != null) video.muted = !!this.options.muted;
    } catch {
      /* detached element */
    }
    this._bindVideo();
    this._bindPageLifecycle();
    this._setState('attaching');
    if (this._hlsUrl && hasHlsJs()) {
      this._initHls();
    } else if (this._hlsUrl && !canUseMse() && nativeHlsSupported(video)) {
      // No MSE: use the platform's native HLS (iOS/Safari) without downloading hls.js.
      this._initNativeHls();
    } else if (this._hlsUrl) {
      ensureHlsLoaded()
        .then((ready) => {
          if (this._destroyed) return;
          if (ready && hasHlsJs()) this._initHls();
          else if (ready && nativeHlsSupported(video)) this._initNativeHls();
          else this._startProgressive('hls-unavailable');
        })
        .catch(() => {
          if (!this._destroyed) this._startProgressive('hls-unavailable');
        });
    } else {
      this._startProgressive();
    }
    return this;
  }

  /** Explicit play intent: starts decoding and queues playback until ready. */
  play() {
    if (this._destroyed) return Promise.resolve(false);
    if (!this._attached) this.attach();
    this._playIntent = true;
    this._cancelTimer('stopLoad');
    this._hintMedia();
    if (this._mode === 'hls') {
      if (this._engine && !this._manifestStarted) this._loadManifest();
      if (this._manifestReady && !this._loadStarted) this._startFragments();
      if (!this._engine) this._setState('loading');
      this._attemptPlay();
    } else if (this._mode === 'mp4' || this._mode === 'native') {
      this._attemptPlay();
    } else {
      this._setState('loading');
    }
    this._emit('playintent');
    return Promise.resolve(true);
  }

  /**
   * Cheap pre-intent used by pointerdown/focus: fetch only the master playlist so
   * the first frame can start sooner. Still no fragments (startLoad needs play()).
   */
  prewarm() {
    if (this._destroyed) return;
    if (!this._attached) this.attach();
    this._hintMedia();
    if (this._mode === 'hls' && this._engine) this._loadManifest();
  }

  pause() {
    if (this._destroyed) return;
    this._playIntent = false;
    this._cancelTimer('playRetry');
    this._attemptingPlay = false;
    try {
      this.video.pause();
    } catch {
      /* detached */
    }
  }

  /** Seek with clamping; applies once metadata exists (fast seek, no reload). */
  seek(time) {
    if (this._destroyed) return;
    let value = Number(time);
    if (!Number.isFinite(value)) return;
    const duration = this.video.duration;
    if (Number.isFinite(duration) && duration > 0) value = Math.min(value, duration - 0.05);
    value = Math.max(0, value);
    if (this._mode === 'hls' && !this._manifestReady) {
      this._pendingSeek = value;
      this._emit('seek', { time: value, pending: true });
      return;
    }
    try {
      this.video.currentTime = value;
    } catch {
      this._pendingSeek = value;
    }
    this._persistPosition(true);
    if (this._manual && this._hls) this._applyLevel(this._levels.findIndex((level) => level.label === this._manual));
    this._emit('seek', { time: value });
  }

  /**
   * Switch quality. `'auto'` releases the manual lock; a tier label/height locks
   * the level without reloading the HLS pipeline, or swaps the progressive MP4
   * source while preserving the position.
   */
  setQuality(quality) {
    if (this._destroyed) return false;
    const value = quality == null || /^auto$/i.test(String(quality)) ? 'auto' : String(quality);
    if (this._mode === 'hls') return this._setHlsQuality(value);
    const tiers = sortTiers(this._sources);
    if (!tiers.length) return false;
    const manual = value === 'auto' ? null : resolveManualQuality(tiers, value);
    if (value !== 'auto' && !manual) {
      this._emit('qualitychange', { requested: value, unavailable: true });
      return false;
    }
    this._manual = manual;
    storeQuality(value === 'auto' ? 'auto' : manual);
    const target =
      (manual && tiers.find((tier) => tier.label === manual)) ||
      pickStartTier(tiers, {
        startLevel: this._startLevel,
        profile: this._profile,
        lowNetwork: this.options.lowNetwork,
      });
    if (!target) return false;
    if (this._currentLevel?.label === target.label) {
      this._emit('levelchange', { ...target, auto: !manual });
      return true;
    }
    this._switchProgressive(target);
    return true;
  }

  /** Idempotent teardown: listeners, timers, hls.js/MSE and position persistence. */
  destroy() {
    if (this._destroyed) return;
    this._setState('destroyed');
    this._destroyed = true;
    this._playIntent = false;
    this._persistPosition(true);
    this._clearTimers();
    try {
      this._abort?.abort();
    } catch {
      /* no AbortController */
    }
    this._teardownHls();
    try {
      if (this.video?.__mosaicPlayback === this) delete this.video.__mosaicPlayback;
    } catch {
      /* frozen element */
    }
    this._emit('destroyed');
    this._events.clear();
  }

  // ---- state / events -----------------------------------------------------

  _setState(next) {
    if (this._destroyed || !next || next === this._state) return;
    const previous = this._state;
    this._state = next;
    this._emit('statechange', { state: next, previous });
  }

  _emit(event, payload) {
    const listeners = this._events.get(event);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[Video] "${event}" listener failed:`, error);
      }
    }
  }

  _timer(name, callback, delay) {
    this._cancelTimer(name);
    this._timers.set(
      name,
      setTimeout(() => {
        this._timers.delete(name);
        if (!this._destroyed) callback();
      }, delay),
    );
  }

  _cancelTimer(name) {
    const timer = this._timers.get(name);
    if (timer != null) {
      clearTimeout(timer);
      this._timers.delete(name);
    }
  }

  _clearTimers() {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
  }

  /** Warm the media origin on first explicit intent (no bytes before this). */
  _hintMedia() {
    hintMedia([this._hlsUrl, ...Object.values(this._sources)]);
  }
}

Object.assign(Playback.prototype, mediaEvents, flow);

export { Playback };
