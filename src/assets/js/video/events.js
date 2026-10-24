/**
 * Player UI/event wiring: control-bar buttons, media element UI events,
 * controls auto-hide, fullscreen/PiP and playlist "next" hand-off.
 *
 * Keyboard shortcuts live in `keyboard.js`, overlay/error feedback in
 * `feedback.js`; decode decisions belong to the playback controller. This
 * module only translates user intent into controller calls and reflects state.
 */
import { registry } from './registry.js';
import { fmtTime, getSpeeds } from './controls.js';

const VOLUME_KEY = 'mosaic_video_volume';
const SPEED_KEY = 'mosaic_video_speed';

export const eventsControls = {
  fmt(seconds) {
    return fmtTime(seconds);
  },

  // ---- speed menu ---------------------------------------------------------

  buildSpeedMenu() {
    if (!this.speedMenu) return;
    this.speedMenu.innerHTML = '';
    this.speedMenu.setAttribute('role', 'menu');
    this.speedMenu.setAttribute('aria-label', '播放速度');
    for (const speed of getSpeeds()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitemradio');
      button.dataset.speed = String(speed);
      button.textContent = `${speed}x`;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.video.playbackRate = speed;
        this.speedMenu.classList.remove('open');
        this.speedBtn?.setAttribute('aria-expanded', 'false');
        this.updateSpeedMenuActive();
        try {
          localStorage.setItem(SPEED_KEY, String(speed));
        } catch {
          /* private mode */
        }
      });
      this.speedMenu.appendChild(button);
    }
    this.updateSpeedMenuActive();
  },

  updateSpeedMenuActive() {
    const speed = this.video?.playbackRate || 1;
    if (this.speedBtn) this.speedBtn.innerHTML = `${speed}x <i class="ri-arrow-down-s-line" aria-hidden="true"></i>`;
    this.speedMenu?.querySelectorAll('button').forEach((button) => {
      const active = Math.abs(parseFloat(button.dataset.speed) - speed) < 0.001;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  },

  // ---- controls visibility ------------------------------------------------

  showControls() {
    if (!this.controls) return;
    this.controls.classList.remove('controls-hidden');
    this.container.classList.remove('controls-hidden');
  },

  hideControls() {
    if (!this.controls || !this.video || this.video.paused) return;
    if (this.container.contains(document.activeElement)) return;
    this.controls.classList.add('controls-hidden');
    this.container.classList.add('controls-hidden');
  },

  toggleMenu(menu) {
    if (!menu) return;
    const open = menu.classList.contains('open');
    this.speedMenu?.classList.remove('open');
    this.qualityMenu?.classList.remove('open');
    this.speedBtn?.setAttribute('aria-expanded', 'false');
    this.qualityBtn?.setAttribute('aria-expanded', 'false');
    if (!open) menu.classList.add('open');
    if (menu === this.speedMenu) this.speedBtn?.setAttribute('aria-expanded', String(!open));
    if (menu === this.qualityMenu) this.qualityBtn?.setAttribute('aria-expanded', String(!open));
  },

  // ---- fullscreen / PiP / next -------------------------------------------

  toggleFullscreen() {
    const container = this.container;
    if (!container) return;
    try {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else container.requestFullscreen?.()?.catch?.(() => {});
    } catch {
      /* unsupported */
    }
  },

  togglePip() {
    const video = this.video;
    if (!video || !document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement) document.exitPictureInPicture?.();
      else video.requestPictureInPicture?.()?.catch?.(() => {});
    } catch {
      /* unsupported */
    }
  },

  /** Next video: existing lazy player, or ask the composition root to mount it. */
  switchToNextVideo() {
    if (!this.total || this.total < 2) return;
    const nextIndex = (this.index + 1) % this.total;
    this.playback?.pause();
    const next = registry.players?.[nextIndex];
    if (next?.video) {
      next.container.scrollIntoView({ behavior: 'smooth', block: 'center' });
      next.playback?.play();
      return;
    }
    const container = registry.mountAt?.(nextIndex);
    if (container) {
      container.scrollIntoView({ behavior: 'smooth', block: 'center' });
      container.dataset.pendingPlay = 'true';
      const mounted = registry.mountAt?.(nextIndex);
      if (mounted) {
        delete container.dataset.pendingPlay;
        mounted.playback?.play();
      }
    }
  },

  // ---- volume / play button ----------------------------------------------

  updatePlayButton() {
    if (!this.playBtn) return;
    const paused = this.video?.paused !== false;
    this.playBtn.innerHTML = paused
      ? '<i class="ri-play-fill" aria-hidden="true"></i>'
      : '<i class="ri-pause-fill" aria-hidden="true"></i>';
    this.playBtn.setAttribute('aria-label', paused ? '播放' : '暂停');
    this.container.classList.toggle('paused', paused);
    this.container.classList.toggle('playing', !paused);
  },

  updateVolumeUi() {
    const video = this.video;
    if (!video) return;
    if (this.volumeBtn) {
      const icon =
        video.muted || video.volume === 0
          ? 'ri-volume-mute-line'
          : video.volume < 0.5
            ? 'ri-volume-down-line'
            : 'ri-volume-up-line';
      this.volumeBtn.innerHTML = `<i class="${icon}" aria-hidden="true"></i>`;
      this.volumeBtn.setAttribute('aria-label', video.muted || video.volume === 0 ? '取消静音' : '静音');
      this.volumeBtn.setAttribute('aria-pressed', video.muted ? 'true' : 'false');
    }
    if (this.volumeRange) this.volumeRange.value = String(Math.round((video.muted ? 0 : video.volume) * 100));
  },

  // ---- binding ------------------------------------------------------------

  bindEvents() {
    const player = this;
    const signal = player.lifecycle.signal;
    const container = player.container;
    const video = player.video;
    const on = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal });

    player.bigPlay?.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        player.togglePlay();
      },
      { signal },
    );
    // Pointer intent prewarms only the master playlist; fragments still need play().
    const prewarm = () => player.playback?.prewarm();
    player.bigPlay?.addEventListener('pointerdown', prewarm, { signal, passive: true });
    player.playBtn?.addEventListener('pointerdown', prewarm, { signal, passive: true });
    player.playBtn?.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        player.togglePlay();
      },
      { signal },
    );
    player.fsBtn?.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        player.toggleFullscreen();
      },
      { signal },
    );
    player.pipBtn?.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        player.togglePip();
      },
      { signal },
    );
    player.nextBtn?.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        player.switchToNextVideo();
      },
      { signal },
    );
    player.speedBtn?.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        player.toggleMenu(player.speedMenu);
      },
      { signal },
    );
    player.qualityBtn?.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        player.toggleMenu(player.qualityMenu);
      },
      { signal },
    );
    player.volumeBtn?.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        video.muted = !video.muted;
        if (!video.muted && video.volume === 0) video.volume = 0.5;
      },
      { signal },
    );
    player.volumeRange?.addEventListener('input', (event) => {
      event.stopPropagation();
      video.muted = false;
      video.volume = Number(event.target.value) / 100;
    });

    if (player.timeCur) {
      player.timeCur.style.cursor = 'pointer';
      player.timeCur.title = '点击复制时间戳';
      player.timeCur.addEventListener(
        'click',
        (event) => {
          event.stopPropagation();
          if (!Number.isFinite(video.currentTime)) return;
          const stamp = player.fmt(video.currentTime);
          navigator.clipboard
            ?.writeText(stamp)
            .then(() => player.showOverlay(`已复制 ${stamp}`))
            .catch(() => {});
        },
        { signal },
      );
    }

    // ---- media element UI events ----
    on(video, 'play', () => {
      player.updatePlayButton();
      player.setBuffering(false);
      player.scheduleHideControls();
    });
    on(video, 'pause', () => {
      player.updatePlayButton();
      player.setBuffering(false);
      player.showControls();
    });
    on(video, 'playing', () => {
      player.setBuffering(false);
      player.updatePlayButton();
      player.scheduleHideControls();
    });
    on(video, 'waiting', () => {
      if (!video.paused) player.setBuffering(true);
    });
    on(video, 'canplay', () => {
      player.setBuffering(false);
      player.updateProgress();
    });
    on(video, 'loadedmetadata', () => {
      if (player.timeDur) player.timeDur.textContent = player.fmt(video.duration);
      player.updateProgress();
    });
    on(video, 'timeupdate', () => {
      player.updateProgress();
      if (player.progressTrack && Number.isFinite(video.duration)) {
        player.progressTrack.setAttribute(
          'aria-valuetext',
          `${player.fmt(video.currentTime)} / ${player.fmt(video.duration)}`,
        );
      }
    });
    on(video, 'volumechange', () => {
      player.updateVolumeUi();
      try {
        localStorage.setItem(VOLUME_KEY, String(video.volume));
      } catch {
        /* private mode */
      }
    });
    on(video, 'ended', () => {
      player.updatePlayButton();
      player.showControls();
      container.dispatchEvent(new CustomEvent('video-ended', { bubbles: true }));
    });
    on(video, 'ratechange', () => player.updateSpeedMenuActive());
    on(video, 'enterpictureinpicture', () => player.pipBtn?.setAttribute('aria-pressed', 'true'));
    on(video, 'leavepictureinpicture', () => player.pipBtn?.setAttribute('aria-pressed', 'false'));

    document.addEventListener(
      'fullscreenchange',
      () => {
        const active = document.fullscreenElement === container;
        player.fsBtn?.setAttribute('aria-pressed', active ? 'true' : 'false');
        if (player.fsBtn) {
          player.fsBtn.innerHTML = active
            ? '<i class="ri-fullscreen-exit-line" aria-hidden="true"></i>'
            : '<i class="ri-fullscreen-line" aria-hidden="true"></i>';
        }
      },
      { signal },
    );

    // ---- controls auto-hide / keyboard focus ----
    on(container, 'mousemove', () => {
      player.showControls();
      player.scheduleHideControls();
    });
    on(container, 'mouseleave', () => player.hideControls());
    on(container, 'focusin', () => {
      player.showControls();
      clearTimeout(player._hideControlsTimer);
    });
    on(container, 'keydown', (event) => player.handleKeyboard(event));

    player.updatePlayButton();
    player.updateVolumeUi();
    player.updateSpeedMenuActive();
  },

  scheduleHideControls() {
    clearTimeout(this._hideControlsTimer);
    this._hideControlsTimer = setTimeout(() => this.hideControls(), 2500);
  },
};
