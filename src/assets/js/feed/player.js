/**
 * Feed playback owner: mounts at most three `<video>` elements (active ±1) and
 * delegates every media concern to playback-quality's unified decode controller
 * (`src/assets/js/video/playback.js`) — no local HLS logic or loaders live here.
 *
 * Intent gating (the fix for "视频解码 flow 触发" bugs):
 *  - `attach()` is request-free, so constructing a neighbour costs zero bytes;
 *  - `play()` on the active slide is the only thing that starts fragments;
 *  - `prewarm()` (master playlist only) is called for the neighbour in the swipe
 *    direction, never for both neighbours up front;
 *  - slides outside ±1 are destroyed so HLS/MSE and the network stop.
 */
import { createPlayback, ensureHlsLoaded } from '../video/playback.js';
import { lowNetwork } from './data.js';

const MUTED_KEY = 'mosaic_feed_muted';

/** @returns {boolean} */
function readMuted() {
  try {
    return localStorage.getItem(MUTED_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * MP4 tiers high → low (fallback-quality ordering only; HLS ABR is the
 * controller's job).
 * @param {Record<string, string>} sources
 * @returns {string[]}
 */
function tierLabels(sources) {
  return Object.keys(sources || {}).sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0));
}

export class FeedPlayer {
  /**
   * @param {{overlay: HTMLElement, onEvent?: (event: string, data: object) => void}} options
   */
  constructor({ overlay, onEvent }) {
    this.overlay = overlay;
    this.onEvent = onEvent || (() => {});
    this.items = [];
    this.active = -1;
    this.muted = readMuted();
    /** @type {Map<number, {controller: object, video: HTMLVideoElement, slide: HTMLElement}>} */
    this.controllers = new Map();
    this.prewarmed = new Set();
    /** @type {Promise<boolean>|null} */
    this.hlsReady = null;
    this.destroyed = false;
  }

  /** @param {Array<object>} items */
  setItems(items) {
    this.items = items || [];
  }

  /** @param {number} index @returns {HTMLElement|null} */
  slide(index) {
    return this.overlay.querySelector(`.feed-slide[data-index="${index}"]`);
  }

  /** @returns {object|null} */
  getController(index = this.active) {
    return this.controllers.get(index)?.controller || null;
  }

  /** Resolve HLS availability once (loads vendor script; still zero media bytes). */
  prime() {
    if (!this.hlsReady) this.hlsReady = ensureHlsLoaded().catch(() => false);
    return this.hlsReady;
  }

  /**
   * Make `index` the single active slide. Neighbours are attached (no requests),
   * far slides are destroyed. Resolves once the active controller is attached.
   * @param {number} index
   * @returns {Promise<void>}
   */
  async activate(index) {
    if (this.destroyed) return;
    this.active = index;
    this.prime();
    // Pause everything else synchronously: exactly one video may play.
    for (const [position, entry] of this.controllers) {
      if (position === index) continue;
      entry.controller.pause?.();
      entry.slide.classList.remove('is-playing');
    }
    await this._ensure(index);
    if (this.destroyed) return;
    this.controllers.get(index)?.controller.play?.();
    this._preload(index - 1);
    this._preload(index + 1);
    this._prune(index);
  }

  /**
   * Swipe/wheel/keyboard intent: prewarm ONLY the neighbour being headed to
   * (fetches its HLS master playlist, never fragments).
   * @param {1|-1} direction
   */
  intent(direction) {
    if (!direction) return;
    const index = this.active + (direction > 0 ? 1 : -1);
    if (index < 0 || index >= this.items.length || this.prewarmed.has(index)) return;
    const entry = this.controllers.get(index);
    if (!entry) return;
    this.prewarmed.add(index);
    entry.controller.prewarm?.();
  }

  /** @param {number} index */
  _preload(index) {
    if (index < 0 || index >= this.items.length || this.controllers.has(index)) return;
    this._ensure(index).catch(() => {});
  }

  /**
   * Create (or reuse) the controller + video element for a slide.
   * @param {number} index
   * @returns {Promise<object|null>}
   */
  async _ensure(index) {
    const existing = this.controllers.get(index);
    if (existing) return existing.controller;
    const item = this.items[index];
    const slide = this.slide(index);
    const media = slide?.querySelector('[data-media]');
    if (!item || !media) return null;
    const video = document.createElement('video');
    video.className = 'feed-video';
    video.muted = this.muted;
    video.playsInline = true;
    video.preload = 'none';
    video.loop = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    if (item.poster) video.poster = item.poster;
    media.appendChild(video);
    let controller;
    try {
      controller = createPlayback({
        video,
        hls: item.hls || undefined,
        sources: item.sources || {},
        poster: item.poster,
        muted: this.muted,
        preload: 'none',
        resume: false,
        mediaId: `feed-${item.slug}`,
        container: slide,
        lowNetwork: lowNetwork(),
      });
    } catch (error) {
      console.warn('[feed] playback controller init failed', error);
      video.remove();
      return null;
    }
    if (this.destroyed) {
      controller.destroy?.();
      video.remove();
      return null;
    }
    const entry = { controller, video, slide };
    this.controllers.set(index, entry);
    this._wire(index, entry);
    controller.attach?.(); // request-free by contract
    return controller;
  }

  /**
   * @param {number} index
   * @param {{controller: object, video: HTMLVideoElement, slide: HTMLElement}} entry
   */
  _wire(index, entry) {
    const { controller, video, slide } = entry;
    const emit = (event, payload) => this.onEvent(event, { index, payload });
    controller.on?.('ready', () => video.classList.add('is-ready'));
    controller.on?.('playing', () => {
      slide.classList.add('is-playing');
      slide.classList.remove('is-paused', 'is-buffering');
      emit('playing');
    });
    controller.on?.('paused', () => {
      if (index !== this.active) {
        slide.classList.remove('is-playing');
        return;
      }
      slide.classList.add('is-paused');
      emit('paused');
    });
    controller.on?.('timeupdate', (payload) => {
      if (index !== this.active) return;
      emit('timeupdate', payload || { time: video.currentTime, duration: video.duration });
    });
    controller.on?.('stalled', () => {
      slide.classList.add('is-buffering');
      this._scheduleDowngrade(index, entry);
    });
    controller.on?.('error', (payload) => {
      slide.classList.remove('is-playing');
      emit('error', payload || {});
    });
    controller.on?.('levelchange', (payload) => emit('levelchange', payload || {}));
    controller.on?.('blocked', () => emit('blocked', {}));
  }

  /**
   * Weak-network resilience: if a slide stalls for 2.5 s, drop one MP4 tier
   * (HLS ABR is handled by the shared controller itself).
   * @param {number} index
   * @param {{controller: object, video: HTMLVideoElement}} entry
   */
  _scheduleDowngrade(index, entry) {
    if (entry._stallTimer || entry._downgraded) return;
    entry._stallTimer = setTimeout(() => {
      entry._stallTimer = 0;
      const tiers = tierLabels(this.items[index]?.sources || {});
      if (tiers.length < 2) return;
      const quality = entry.controller.quality || 'auto';
      const position = tiers.indexOf(quality);
      const next = tiers[Math.min(position + 1, tiers.length - 1)];
      if (!next || next === quality) return;
      entry._downgraded = true;
      entry.controller.setQuality?.(next);
      this.onEvent('downgrade', { index, payload: { label: next } });
    }, 2500);
  }

  /** Destroy slides further than ±1 from the active index. @param {number} index */
  _prune(index) {
    for (const [position, entry] of [...this.controllers]) {
      if (Math.abs(position - index) <= 1) continue;
      this._disposeEntry(position, entry);
    }
  }

  /** @param {number} position @param {object} entry */
  _disposeEntry(position, entry) {
    clearTimeout(entry._stallTimer);
    try {
      entry.controller.destroy?.();
    } catch {
      /* already destroyed */
    }
    entry.video.remove();
    this.controllers.delete(position);
    this.prewarmed.delete(position);
  }

  pause() {
    this.getController()?.pause?.();
  }

  resume() {
    this.getController()?.play?.();
  }

  /** @returns {boolean} */
  isPaused() {
    const video = this.controllers.get(this.active)?.video;
    return !video || video.paused;
  }

  /** @param {number} ratio 0..1 */
  seekRatio(ratio) {
    const entry = this.controllers.get(this.active);
    if (!entry) return;
    const duration = entry.video.duration || this.items[this.active]?.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    entry.controller.seek?.(Math.max(0, Math.min(1, ratio)) * duration);
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.muted = muted;
    for (const entry of this.controllers.values()) entry.video.muted = muted;
    try {
      localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
    } catch {
      /* private mode */
    }
  }

  /** @returns {boolean} */
  isMuted() {
    return this.muted;
  }

  destroy() {
    this.destroyed = true;
    for (const [position, entry] of [...this.controllers]) this._disposeEntry(position, entry);
    this.controllers.clear();
    this.prewarmed.clear();
  }
}
