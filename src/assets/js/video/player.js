/**
 * Post-page video player: composes the unified decode controller with the
 * control-bar modules. All network/decode decisions live in `playback.js`; this
 * class owns DOM contracts (`.video-element`, `.vc-play`, `data-player-ready`),
 * UI wiring and lifecycle.
 *
 * Module split (each file has a single responsibility):
 *   playback.js  decode flow / state machine     progress.js  progress bar
 *   events.js    media + control events          gestures.js  taps/long-press
 *   quality.js   quality menu                    controls.js  constants/fmt
 */
import { createPlayback } from './playback.js';
import { getSpeeds } from './controls.js';
import { eventsControls } from './events.js';
import { feedbackControls } from './feedback.js';
import { keyboardControls } from './keyboard.js';
import { progressControls, initProgress } from './progress.js';
import { initGestures } from './gestures.js';
import { qualityControls } from './quality.js';

const SPEED_KEY = 'mosaic_video_speed';
const VOLUME_KEY = 'mosaic_video_volume';

/** @private */
class VideoPlayer {
  /**
   * @param {HTMLElement} container `.video-container`
   * @param {number} [index]
   * @param {number} [total]
   */
  constructor(container, index = 0, total) {
    this.lifecycle = new AbortController();
    this.container = container;
    this.video = container.querySelector('.video-element');
    if (!this.video) return;
    this.index = index;
    this.total = total || parseInt(container.dataset.total, 10) || 1;
    this._destroyed = false;
    this._unsubscribers = [];
    this.cacheUi();
    this.restorePreferences();

    const hlsSource = container.querySelector('source[type="application/x-mpegURL"]');
    this.hlsUrl = hlsSource?.src || '';
    this.sources = {};
    container.querySelectorAll('source[data-res]').forEach((source) => {
      if (source.src) this.sources[source.dataset.res] = source.src;
    });

    this.playback = createPlayback({
      video: this.video,
      hls: this.hlsUrl || undefined,
      sources: Object.keys(this.sources).length ? this.sources : undefined,
      poster: this.video.getAttribute('poster') || undefined,
      mediaId: this.video.dataset.mediaId,
      container,
      preload: 'none',
    });
    this.bindPlayback();
    this.playback.attach();

    this.bindEvents();
    initProgress(this);
    initGestures(this);
    this.buildSpeedMenu();
    this.buildQualityMenu();
    this.decorate();
    this.showControls();
    this.markReady();
    this.replayPendingPlay();
  }

  /** Live hls.js instance (debugging + tests); absent for MP4/native players. */
  get hls() {
    return this.playback?.hls || null;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    try {
      this.lifecycle.abort();
    } catch {
      /* no AbortController */
    }
    for (const unsubscribe of this._unsubscribers) {
      try {
        unsubscribe();
      } catch {
        /* listener already gone */
      }
    }
    this._unsubscribers = [];
    this.playback?.destroy();
    this._stopProgressRaf();
    clearTimeout(this._hideControlsTimer);
    clearTimeout(this._toastTimer);
    clearTimeout(this._overlayTimer);
  }

  /** Toggle playback; play() carries an explicit intent into the controller. */
  togglePlay() {
    if (!this.playback) return;
    if (this.video.paused) {
      this.setBuffering(true);
      this.playback.play();
    } else {
      this.playback.pause();
    }
  }

  /** Backwards-compatible hook used by the playlist and tests. */
  startLoading() {
    this.playback?.play();
  }

  // ---- composition helpers ------------------------------------------------

  cacheUi() {
    const container = this.container;
    this.bigPlay = container.querySelector('.video-big-play');
    this.controls = container.querySelector('.video-controls');
    this.playBtn = container.querySelector('.vc-play');
    this.timeCur = container.querySelector('.vc-time-current');
    this.timeDur = container.querySelector('.vc-time-duration');
    this.progressFill = container.querySelector('.vc-progress-fill');
    this.progressBuffer = container.querySelector('.vc-progress-buffer');
    this.progressTrack = container.querySelector('.vc-progress-track');
    this.progressThumb = container.querySelector('.vc-progress-thumb');
    this.progressTooltip = container.querySelector('.vc-progress-hover');
    this.volumeBtn = container.querySelector('.vc-volume-btn');
    this.volumeRange = container.querySelector('.vc-volume-range');
    this.speedBtn = container.querySelector('.vc-speed-btn');
    this.speedMenu = container.querySelector('.vc-speed-menu');
    this.qualityBtn = container.querySelector('.vc-quality-btn');
    this.qualityMenu = container.querySelector('.vc-quality-menu');
    this.nextBtn = container.querySelector('.vc-next');
    this.pipBtn = container.querySelector('.vc-pip');
    this.fsBtn = container.querySelector('.vc-fullscreen');
  }

  restorePreferences() {
    try {
      const speed = parseFloat(localStorage.getItem(SPEED_KEY));
      if (Number.isFinite(speed) && getSpeeds().includes(speed)) this.video.playbackRate = speed;
      const volume = parseFloat(localStorage.getItem(VOLUME_KEY));
      if (Number.isFinite(volume)) this.video.volume = Math.max(0, Math.min(1, volume));
    } catch {
      /* private mode */
    }
  }

  /** Reflect controller state into the UI (quality menu, toasts, errors). */
  bindPlayback() {
    const playback = this.playback;
    const on = (event, handler) => this._unsubscribers.push(playback.on(event, handler));
    on('levels', () => this.buildQualityMenu());
    on('levelchange', (level) => this.updateQualityActive(level));
    on('switching', (level) => this.showSwitchToast(`切换到 ${level.label}`));
    on('fallback', () => {
      this.clearError();
      this.showSwitchToast('已切换备用源');
      this.buildQualityMenu();
    });
    on('downgrade', () => this.showSwitchToast('网络较慢，已自动降低清晰度'));
    on('restored', ({ position }) => this.showSwitchToast(`已恢复播放位置 ${this.fmt(position)}`));
    on('blocked', () => this.showOverlay('点击播放'));
    on('error', (error) => {
      if (!error?.fatal) return;
      if (/no-playable-source|no-progressive-source/.test(String(error.details || ''))) this.showError(error);
    });
  }

  /** DOM contracts, ARIA, poster LQIP and control initial state. */
  decorate() {
    const container = this.container;
    const video = this.video;
    if (container.tabIndex < 0) container.tabIndex = 0;
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', this.total > 1 ? `视频播放器 ${this.index + 1}/${this.total}` : '视频播放器');
    container.classList.add('paused');
    if (this.poster && !container.classList.contains('has-poster')) {
      container.classList.add('has-poster');
      container.style.backgroundImage = `url("${this.poster}")`;
    }
    if (this.timeDur) this.timeDur.textContent = '0:00';
    if (this.timeCur) this.timeCur.textContent = '0:00';
    if (this.progressTrack) {
      this.progressTrack.setAttribute('role', 'slider');
      this.progressTrack.setAttribute('aria-label', '播放进度');
      this.progressTrack.setAttribute('aria-valuemin', '0');
      this.progressTrack.setAttribute('aria-valuemax', '100');
      this.progressTrack.setAttribute('aria-valuenow', '0');
      this.progressTrack.setAttribute('aria-valuetext', '0:00');
      if (this.progressTrack.tabIndex < 0) this.progressTrack.tabIndex = 0;
    }
    this.speedBtn?.setAttribute('aria-label', '播放速度');
    this.speedBtn?.setAttribute('aria-expanded', 'false');
    this.qualityBtn?.setAttribute('aria-label', '清晰度');
    this.qualityBtn?.setAttribute('aria-expanded', 'false');
    this.fsBtn?.setAttribute('aria-label', '全屏');
    this.nextBtn?.setAttribute('aria-label', '下一个视频');
    if (this.pipBtn && !document.pictureInPictureEnabled) this.pipBtn.hidden = true;
    else this.pipBtn?.setAttribute('aria-label', '画中画');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    this.updatePlayButton();
    this.updateVolumeUi();
    this.updateSpeedMenuActive();
    this.updateQualityActive();
  }

  markReady() {
    this.container.dataset.playerReady = 'true';
    this.container.removeAttribute('aria-busy');
    this.container.classList.remove('buffering');
  }

  /** A click captured by the template before the lazy player mounted is replayed. */
  replayPendingPlay() {
    if (this.container.dataset.pendingPlay !== 'true') return;
    delete this.container.dataset.pendingPlay;
    this.setBuffering(true);
    this.playback?.play();
  }
}

Object.assign(
  VideoPlayer.prototype,
  eventsControls,
  feedbackControls,
  keyboardControls,
  progressControls,
  qualityControls,
);

export { VideoPlayer };
