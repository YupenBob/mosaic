/**
 * Decode-flow internals for the playback controller (engine lifecycle, ABR
 * locking, error recovery, MP4 fallback and tier switches).
 *
 * Exposed as a mixin consumed by `playback.js`; every method runs with a
 * `Playback` instance as `this` and only touches its underscore-prefixed state.
 */
import { createHlsEngine, destroyHlsEngine } from './engine.js';
import { nativeHlsSupported } from './hls-loader.js';
import {
  buildHlsConfig,
  nearestLevelIndex,
  pickStartTier,
  playerConfig,
  resolveManualQuality,
  sortTiers,
  storeQuality,
} from './tune.js';

const FATAL_LIMIT = 3;
const MANIFEST_FAILURE = /manifest|levelLoad/i;

export const flow = {
  // ---- engine lifecycle --------------------------------------------------

  _initHls() {
    if (this._destroyed || this._engine) return;
    const config = buildHlsConfig(playerConfig().hls || {}, {
      profile: this._profile,
      lowNetwork: this.options.lowNetwork || this._profile.saveData,
    });
    try {
      this._engine = createHlsEngine({
        video: this.video,
        options: config,
        callbacks: {
          onManifest: (levels) => this._onManifest(levels),
          onLevelSwitched: (data) => this._onLevelSwitched(data),
          onFragLoaded: () => {
            this._fatalCount = 0;
          },
          onError: (data) => this._onHlsError(data),
        },
      });
      this._hls = this._engine.hls;
      this._mode = 'hls';
      if (this._state === 'attaching') this._setState(this._playIntent ? 'loading' : 'ready');
      // A play intent may have arrived while hls.js was being fetched.
      if (this._playIntent) this._loadManifest();
    } catch (error) {
      this._emit('error', { fatal: true, details: 'hls-engine-init', error });
      this._startProgressive('engine-failed');
    }
  },

  /**
   * Fetch the HLS master playlist. Intent-gated: only called from play()/prewarm()
   * after the user engaged with the player, never from attach().
   */
  _loadManifest() {
    if (this._destroyed || this._manifestStarted || this._manifestReady || !this._engine) return;
    this._manifestStarted = true;
    this._setState('loading');
    this._emit('loading');
    this._engine.loadSource(this._hlsUrl);
  },

  _initNativeHls() {
    if (this._destroyed) return;
    this._mode = 'native';
    try {
      this.video.src = this._hlsUrl;
    } catch {
      /* detached */
    }
    this._setState('ready');
    this._emit('levels', { levels: [], mode: 'native' });
    this._emit('ready', { mode: 'native', levels: [] });
  },

  _startProgressive(reason) {
    if (this._destroyed) return;
    if (this._hlsUrl && !this._hls && nativeHlsSupported(this.video) && !sortTiers(this._sources).length) {
      this._initNativeHls();
      return;
    }
    this._mode = 'mp4';
    const tiers = sortTiers(this._sources);
    if (!tiers.length) {
      this._setState('ready');
      this._emit('error', { fatal: true, reason, details: 'no-playable-source' });
      return;
    }
    const manual = resolveManualQuality(tiers, this.options.quality);
    const chosen =
      (manual && tiers.find((tier) => tier.label === manual)) ||
      pickStartTier(tiers, {
        startLevel: this._startLevel,
        profile: this._profile,
        lowNetwork: this.options.lowNetwork,
      }) ||
      tiers[0];
    this._manual = manual;
    this._levels = tiers.map((tier, index) => ({ ...tier, index, bitrate: 0, detail: '' }));
    this._applyProgressiveSource(chosen);
    this._setState('ready');
    this._emit('levels', { levels: this._levels, mode: 'mp4' });
    this._emit('ready', { mode: 'mp4', levels: this._levels });
    this._emit('levelchange', { ...chosen, auto: !manual });
    if (this.options.preload === 'metadata' || this.options.preload === 'auto') {
      try {
        this.video.preload = this.options.preload;
        this.video.load?.();
      } catch {
        /* detached */
      }
    }
  },

  _applyProgressiveSource(tier) {
    this._progressive = tier;
    this._currentLevel = tier;
    try {
      this.video.src = tier.url;
    } catch {
      /* detached */
    }
  },

  // ---- HLS manifest / levels --------------------------------------------

  _onManifest(levels) {
    if (this._destroyed) return;
    this._manifestStarted = true;
    this._manifestReady = true;
    this._levels = levels || [];
    const manual = resolveManualQuality(this._levels, this.options.quality);
    this._manual = manual;
    if (manual) this._applyLevel(nearestLevelIndex(this._levels, manual));
    if (this._pendingQuality) {
      const pending = this._pendingQuality;
      this._pendingQuality = null;
      this.setQuality(pending);
    }
    this._setState(this._playIntent ? 'loading' : 'ready');
    this._emit('levels', { levels: this._levels, mode: 'hls' });
    this._emit('ready', { mode: 'hls', levels: this._levels });
    if (this._playIntent) this._startFragments();
  },

  _onLevelSwitched(data) {
    if (this._destroyed) return;
    const level = this._levels[Number(data.level)];
    if (!level) return;
    this._currentLevel = level;
    this._emit('levelchange', { ...level, auto: !this._manual });
  },

  _setHlsQuality(value) {
    if (value === 'auto') {
      this._manual = null;
      storeQuality('auto');
      if (this._hls) {
        try {
          this._hls.loadLevel = -1;
          this._hls.nextLevel = -1;
          this._hls.autoLevelCapping = -1;
        } catch {
          /* partial test double */
        }
      }
      this._emit('levelchange', { label: 'auto', auto: true });
      return true;
    }
    if (!this._levels.length) {
      this._pendingQuality = value;
      return true;
    }
    const index = nearestLevelIndex(this._levels, value);
    if (index < 0) return false;
    this._manual = this._levels[index].label;
    storeQuality(this._manual);
    this._applyLevel(index);
    this._emit('levelchange', { ...this._levels[index], auto: false });
    return true;
  },

  _applyLevel(index) {
    if (!this._hls || index < 0) return;
    try {
      // Setting loadLevel/nextLevel is the hls.js manual lock: ABR stays off
      // until setQuality('auto') releases it again.
      this._hls.loadLevel = index;
      this._hls.nextLevel = index;
    } catch {
      /* partial test double */
    }
  },

  _startFragments() {
    // Fragments may only start after the manifest exists and an intent was given.
    if (!this._hls || !this._manifestReady || this._loadStarted) return;
    this._loadStarted = true;
    this._setState('loading');
    this._emit('loading');
    try {
      this._hls.startLoad(this._restored ? Math.max(0, this.video.currentTime || 0) : -1);
    } catch {
      this._fallback('start-load-failed');
    }
  },

  // ---- recovery / fallback ----------------------------------------------

  _onHlsError(data) {
    if (this._destroyed || this._fallbackStarted) return;
    const type = String(data.type || '');
    const details = String(data.details || '');
    if (!data.fatal) {
      if (/bufferStalled/i.test(details)) this._handleStall();
      return;
    }
    this._emit('error', { fatal: true, type, details, error: data.error || null });
    if (MANIFEST_FAILURE.test(details)) {
      this._fallback('manifest');
      return;
    }
    this._fatalCount += 1;
    if (this._fatalCount >= FATAL_LIMIT) {
      this._fallback('recovery-exhausted');
      return;
    }
    this._setState('recovering');
    this._emit('recovering', { type, details, attempt: this._fatalCount });
    if (type === 'mediaError') {
      try {
        this._hls?.recoverMediaError?.();
      } catch {
        this._fallback('media-error');
      }
      return;
    }
    this._timer(
      'recover',
      () => {
        if (this._destroyed || !this._hls) return;
        try {
          if (type === 'networkError') this._hls.startLoad();
          else this._hls.recoverMediaError?.();
        } catch {
          this._fallback('recovery-failed');
          return;
        }
        this._setState(this._playIntent ? 'loading' : 'ready');
      },
      250 * this._fatalCount,
    );
  },

  /** Tear hls.js down and continue with a progressive MP4 tier (one code path). */
  _fallback(reason) {
    if (this._destroyed || this._fallbackStarted) return;
    this._fallbackStarted = true;
    this._teardownHls();
    const tiers = sortTiers(this._sources);
    this._emit('fallback', { reason, tiers: tiers.map((tier) => tier.label) });
    if (!tiers.length) {
      this._setState('ready');
      this._emit('error', { fatal: true, reason, details: 'no-progressive-source' });
      return;
    }
    this._mode = 'mp4';
    this._levels = tiers.map((tier, index) => ({ ...tier, index, bitrate: 0, detail: '' }));
    const keptManual = this._manual ? tiers.find((tier) => tier.label === this._manual) : null;
    const chosen = keptManual || this._fallbackTier(tiers);
    this._manual = keptManual ? keptManual.label : null;
    this._applyProgressiveSource(chosen);
    this._setState(this._playIntent ? 'loading' : 'fallback');
    this._emit('levels', { levels: this._levels, mode: 'mp4', fallback: true });
    this._emit('levelchange', { ...chosen, auto: !keptManual, fallback: true });
    if (this._playIntent) this._attemptPlay();
  },

  _fallbackTier(tiers) {
    const reference = this._currentLevel?.height || this._levels[0]?.height || 0;
    if (reference > 0) {
      const atOrBelow = tiers.filter((tier) => tier.height <= reference);
      if (atOrBelow.length) return atOrBelow[atOrBelow.length - 1];
    }
    return tiers[tiers.length - 1];
  },

  _teardownHls() {
    const hls = this._hls;
    this._hls = null;
    this._engine = null;
    this._loadStarted = false;
    destroyHlsEngine(hls);
    try {
      if (this.video?._hls === hls) delete this.video._hls;
    } catch {
      /* frozen element */
    }
  },

  /** Position-preserving progressive tier switch; the poster covers the swap. */
  _switchProgressive(tier) {
    const token = (this._switchToken += 1);
    const wasPlaying = !this.video.paused || this._playIntent;
    const time = this.video.currentTime;
    const video = this.video;
    const signal = this._abort?.signal;
    this._restored = true;
    this._currentLevel = tier;
    this._setState('loading');
    this._emit('switching', { ...tier });
    const onMetadata = () => {
      if (this._destroyed || token !== this._switchToken) return;
      if (Number.isFinite(time) && time > 0) {
        try {
          video.currentTime = time;
        } catch {
          /* clamped by duration */
        }
      }
      this._emit('levelchange', { ...tier, auto: !this._manual });
      this._setState('ready');
      if (wasPlaying) this._attemptPlay();
    };
    try {
      video.addEventListener('loadedmetadata', onMetadata, { ...(signal ? { signal } : {}), once: true });
      video.src = tier.url;
      video.load?.();
    } catch {
      this._emit('error', { fatal: false, details: 'quality-switch', tier: tier.label });
    }
  },
};
