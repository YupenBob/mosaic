import { SPEEDS, RES_ORDER, qualityControls } from './controls.js';
import { initHls } from './engine.js';
import { registry } from './registry.js';
let _logLevel = 'info'; // debug | info | warn | error

function vlog(level, msg) {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((order[level] || 0) >= (order[_logLevel] || 0)) {
    console.log('[Video ' + level.toUpperCase() + '] ' + msg);
  }
}

class VideoPlayer {
  destroy() {
    this.lifecycle?.abort();
    this.video?.pause();
    this.hls?.destroy();
    cancelAnimationFrame(this._rafId);
    for (const key of Object.keys(this)) if (key.endsWith('Timer')) clearTimeout(this[key]);
  }

  constructor(container, index, total) {
    const lifecycle = this.lifecycle || (this.lifecycle = new AbortController());

    this.container = container;
    this.video = container.querySelector('.video-element');
    if (!this.video) return;

    this.index = index;
    this.total = total || parseInt(container.dataset.total) || 1;

    // Parse sources (multi-res or single)
    this.sources = {};
    var sourceEls = container.querySelectorAll('source[data-res]');
    sourceEls.forEach(
      function (s) {
        this.sources[s.dataset.res] = s.src;
      }.bind(this),
    );

    // Check for HLS
    var hlsSource = container.querySelector('source[type="application/x-mpegURL"]');
    this.isHLS = !!hlsSource;
    this.hls = null;

    if (
      this.isHLS &&
      (!window.Hls || window.Hls.isSupported?.() === false) &&
      !this.video.canPlayType('application/vnd.apple.mpegurl')
    )
      this.isHLS = false;

    initHls.call(this, hlsSource, vlog);

    // Initialize sources for non-HLS or HLS fallback
    if (!this.isHLS) {
      if (!sourceEls.length && this.video.src) this.sources.single = this.video.src;
      this.currentRes = this.detectResolution();
      if (sourceEls.length > 0 && this.sources[this.currentRes]) {
        sourceEls.forEach(function (s) {
          s.remove();
        });
        this.video.src = this.sources[this.currentRes];
      }
    }

    // Restore preferences + position
    try {
      const storedSpeed = parseFloat(localStorage.getItem('mosaic_video_speed'));
      if (storedSpeed && SPEEDS.includes(storedSpeed)) this.video.playbackRate = storedSpeed;
      const storedVol = parseFloat(localStorage.getItem('mosaic_video_volume'));
      if (!isNaN(storedVol)) this.video.volume = Math.max(0, Math.min(1, storedVol));
    } catch {}
    // Restore playback position
    try {
      const posKey = 'mosaic_video_pos_' + (this.video.src || container.querySelector('source')?.src || '').slice(-40);
      const savedPos = parseFloat(localStorage.getItem(posKey));
      if (savedPos > 1 && savedPos < (this.video.duration || Infinity)) {
        this.video.currentTime = savedPos;
      }
    } catch {}

    // Cache elements
    this.bigPlay = container.querySelector('.video-big-play');
    this.controls = container.querySelector('.video-controls');
    this.playBtn = container.querySelector('.vc-play');
    this.timeCur = container.querySelector('.vc-time-current');
    if (this.timeCur) {
      this.timeCur.style.cursor = 'pointer';
      this.timeCur.title = 'Click to copy timestamp';
      this.timeCur.addEventListener(
        'click',
        () => {
          if (!isFinite(this.video.currentTime)) return;
          const ts = this.fmt(this.video.currentTime);
          navigator.clipboard
            ?.writeText(ts)
            .then(() => this.showOverlay('复制成功 ' + ts))
            .catch(() => {});
        },
        { signal: lifecycle.signal },
      );
    }
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

    // Build speed menu
    if (this.speedMenu) this.buildSpeedMenu();
    // Build quality menu
    if (this.qualityMenu) this.buildQualityMenu();

    // Pause RAF when tab hidden
    var me = this;
    document.addEventListener(
      'visibilitychange',
      function () {
        if (document.hidden && me._rafId) {
          cancelAnimationFrame(me._rafId);
          me._rafId = null;
        }
      },
      { signal: lifecycle.signal },
    );

    // Events
    this.bindEvents();

    // Show controls on load
    this.showControls();
  }

  /**
   * hls.js hit an unrecoverable fatal error: destroy it and degrade to the
   * best MP4 tier rendered as a data-res fallback source.
   */
  destroyHls() {
    try {
      if (this.hls) this.hls.destroy();
    } catch {}
    this.hls = null;
    const mp4s = this.container.querySelectorAll('source[data-res][src]');
    if (!mp4s.length) return;
    const rank = (res) => (res === '4K' ? 2160 : parseInt(res) || 0);
    let best = null;
    let bestRank = -1;
    mp4s.forEach((s) => {
      const r = rank(s.dataset.res);
      if (r > bestRank) {
        bestRank = r;
        best = s;
      }
    });
    if (!best) return;
    this.sources = {};
    mp4s.forEach((s) => {
      this.sources[s.dataset.res] = s.src;
    });
    this.currentRes = best.dataset.res;
    this.video.src = best.src;
    this.video.play().catch(() => {});
    if (this.qualityMenu) this.buildQualityMenu();
    this.updateQualityActive();
    vlog('warn', 'HLS unrecoverable — fell back to MP4 (' + best.dataset.res + ')');
  }

  detectResolution() {
    // Check stored preference first
    try {
      const stored = localStorage.getItem('mosaic_video_quality');
      if (stored && ['360p', '480p', '720p', '1080p'].includes(stored)) return stored;
    } catch {}
    const w = window.innerWidth;
    const dpr = window.devicePixelRatio || 1;
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const isSlow = conn && (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g');
    if (isSlow) return '360p';
    if (w * dpr >= 1920) return '1080p';
    if (w * dpr >= 1280) return '720p';
    if (w * dpr >= 640) return '480p';
    return '360p';
  }

  buildSpeedMenu() {
    const lifecycle = this.lifecycle || (this.lifecycle = new AbortController());

    SPEEDS.forEach((s) => {
      const btn = document.createElement('button');
      btn.textContent = s + 'x';
      btn.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          this.video.playbackRate = s;
          this.speedBtn.innerHTML = s + 'x <i class="ri-arrow-down-s-line"></i>';
          this.speedMenu.classList.remove('open');
          this.updateSpeedMenuActive();
          try {
            localStorage.setItem('mosaic_video_speed', s);
          } catch {}
        },
        { signal: lifecycle.signal },
      );
      this.speedMenu.appendChild(btn);
    });
    this.updateSpeedMenuActive();
  }

  updateSpeedMenuActive() {
    const speed = this.video.playbackRate;
    if (this.speedBtn) this.speedBtn.innerHTML = speed + 'x <i class="ri-arrow-down-s-line"></i>';
    this.speedMenu.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', parseFloat(b.textContent) === speed);
    });
  }

  isAuto() {
    return this.currentRes === 'auto';
  }

  _relockQuality() {
    const targetH = parseInt(this.currentRes);
    if (isNaN(targetH)) return;
    const idx = (this.hls.levels || []).findIndex(function (l) {
      return l.height === targetH || l.height >= targetH;
    });
    if (idx >= 0) {
      this.hls.loadLevel = idx;
      this.hls.nextLevel = idx;
    }
  }

  showSwitchToast(msg) {
    var el = this.container.querySelector('.vc-switch-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'vc-switch-toast';
      this.container.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () {
      el.classList.remove('show');
    }, 2000);
  }

  switchResolution(res) {
    const lifecycle = this.lifecycle || (this.lifecycle = new AbortController());

    if (res === this.currentRes || this._switching) return;
    var prevRes = this.currentRes;
    this._switching = true;
    const time = this.video.currentTime;
    this.currentRes = res;

    var label = res === 'auto' ? 'Auto' : res;
    vlog('info', 'Switching quality: ' + prevRes + ' -> ' + res);
    this.showSwitchToast('Switching to ' + label + '...');

    // Safety unlock after 3s
    var self = this;
    this._unlockTimer = setTimeout(function () {
      self._switching = false;
    }, 3000);

    if (this.hls) {
      // Don't seek — hls.js handles level switch seamlessly with old buffer
      if (res === 'auto') {
        this._switching = false;
        this.hls.loadLevel = -1;
        this.hls.nextLevel = -1;
        this.hls.autoLevelCapping = -1;
      } else {
        const targetH = parseInt(res);
        const levels = this.hls.levels || [];
        let idx = levels.findIndex(function (l) {
          return l.height === targetH;
        });
        if (idx < 0 && levels.length > 0) {
          idx = levels.findIndex(function (l) {
            return l.height >= targetH;
          });
        }
        if (idx >= 0) {
          this.hls.loadLevel = idx;
          this.hls.nextLevel = idx;
          // Setting loadLevel/nextLevel locks the tier (ABR disabled in hls.js)
          vlog('info', 'loadLevel=' + idx + ', ABR disabled');
        }
      }
    } else {
      if (!this.sources[res]) {
        this._switching = false;
        return;
      }
      this.video.querySelectorAll('source').forEach((s) => s.remove());
      this.video.src = this.sources[res];
      this.video.load();
      const onReady = () => {
        this._switching = false;
        try {
          this.video.currentTime = time;
        } catch {}
        if (!this.video.paused) this.video.play()?.catch(() => {});
      };
      this.video.addEventListener('canplay', onReady, { ...{ once: true }, signal: lifecycle.signal });
    }
    this.updateQualityActive();
    try {
      localStorage.setItem('mosaic_video_quality', res);
    } catch {}
  }

  bindEvents() {
    const lifecycle = this.lifecycle || (this.lifecycle = new AbortController());

    const v = this.video;
    const c = this.container;
    const self = this;

    // === Core playback events (merged) ===
    if (this.bigPlay) {
      this.bigPlay.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          this.togglePlay();
        },
        { signal: lifecycle.signal },
      );
    }
    c.addEventListener(
      'click',
      (e) => {
        if (!e.target.closest('.video-controls, .video-big-play')) this.togglePlay();
      },
      { signal: lifecycle.signal },
    );
    if (this.playBtn) {
      this.playBtn.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          this.togglePlay();
        },
        { signal: lifecycle.signal },
      );
    }

    v.addEventListener(
      'play',
      () => {
        c.classList.add('playing');
        c.classList.remove('paused');
        if (this.playBtn) this.playBtn.innerHTML = '<i class="ri-pause-fill"></i>';
      },
      { signal: lifecycle.signal },
    );
    v.addEventListener(
      'pause',
      () => {
        c.classList.add('paused');
        c.classList.remove('playing');
        if (this.playBtn) this.playBtn.innerHTML = '<i class="ri-play-fill"></i>';
      },
      { signal: lifecycle.signal },
    );
    v.addEventListener(
      'loadedmetadata',
      () => {
        if (this.timeDur) this.timeDur.textContent = this.fmt(v.duration);
      },
      { signal: lifecycle.signal },
    );

    // Merged timeupdate: progress + freeze detect + position save
    var _stuckCount = 0;
    v.addEventListener(
      'timeupdate',
      () => {
        this.updateProgress();
        // Freeze detection
        if (v.readyState < 3 && !v.paused) {
          _stuckCount++;
          if (_stuckCount >= 5) c.classList.add('buffering');
        } else {
          _stuckCount = 0;
          c.classList.remove('buffering');
        }
        // Save position
        try {
          if (v.currentTime > 1) localStorage.setItem('mosaic_video_pos_' + (v.src || '').slice(-40), v.currentTime);
        } catch {}
      },
      { signal: lifecycle.signal },
    );

    // Merged waiting: spinner + adaptive downgrade
    var _waitingTimer = null;
    v.addEventListener(
      'waiting',
      () => {
        c.classList.add('buffering');
        vlog('warn', 'Buffering...');
        // Adaptive downgrade for MP4 (not HLS — hls.js handles ABR)
        if (!this.isHLS && !this._switching) {
          _waitingTimer = setTimeout(() => {
            const idx = RES_ORDER.indexOf(this.currentRes);
            if (idx < RES_ORDER.length - 1 && !self._switching) {
              const lower = RES_ORDER[idx + 1];
              if (self.sources[lower]) self.switchResolution(lower);
            }
          }, 3000);
        }
      },
      { signal: lifecycle.signal },
    );
    v.addEventListener(
      'canplay',
      () => {
        c.classList.remove('buffering');
      },
      { signal: lifecycle.signal },
    );
    v.addEventListener(
      'playing',
      () => {
        c.classList.remove('buffering');
        _waitingTimer && clearTimeout(_waitingTimer);
      },
      { signal: lifecycle.signal },
    );
    v.addEventListener(
      'ended',
      () => {
        c.dispatchEvent(new CustomEvent('video-ended', { bubbles: true }));
      },
      { signal: lifecycle.signal },
    );

    // Volume
    v.addEventListener(
      'volumechange',
      () => {
        try {
          localStorage.setItem('mosaic_video_volume', v.volume);
        } catch {}
        if (this.volumeBtn)
          this.volumeBtn.innerHTML =
            v.muted || v.volume === 0
              ? '<i class="ri-volume-mute-line"></i>'
              : v.volume < 0.5
                ? '<i class="ri-volume-down-line"></i>'
                : '<i class="ri-volume-up-line"></i>';
        if (this.volumeRange) this.volumeRange.value = Math.round(v.volume * 100);
      },
      { signal: lifecycle.signal },
    );
    if (this.volumeBtn) {
      this.volumeBtn.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          v.muted = !v.muted;
        },
        { signal: lifecycle.signal },
      );
    }
    if (this.volumeRange) {
      this.volumeRange.addEventListener(
        'input',
        (e) => {
          e.stopPropagation();
          v.volume = e.target.value / 100;
          v.muted = false;
        },
        { signal: lifecycle.signal },
      );
    }

    // === Progress bar (click, hover, drag) ===
    if (this.progressTrack) {
      this.progressTrack.addEventListener(
        'click',
        (e) => {
          const rect = this.progressTrack.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          if (!isFinite(v.duration)) return;
          v.currentTime = pct * v.duration;
          if (this.progressFill) this.progressFill.style.width = pct * 100 + '%';
          if (this.progressThumb) this.progressThumb.style.left = pct * 100 + '%';
          // Re-lock quality after click-seek
          if (self.hls && !self.isAuto()) self._relockQuality();
        },
        { signal: lifecycle.signal },
      );
      this.progressTrack.addEventListener(
        'mousemove',
        (e) => {
          const rect = this.progressTrack.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          if (this.progressTooltip && isFinite(v.duration)) {
            this.progressTooltip.textContent = this.fmt(v.duration * pct);
            this.progressTooltip.style.left = pct * 100 + '%';
            this.progressTooltip.style.opacity = '1';
          }
        },
        { signal: lifecycle.signal },
      );
      this.progressTrack.addEventListener(
        'mouseleave',
        () => {
          if (this.progressTooltip) this.progressTooltip.style.opacity = '0';
        },
        { signal: lifecycle.signal },
      );
      // Drag seek — supresses RAF smooth animation during drag
      var _drag = false;
      this.progressTrack.addEventListener(
        'mousedown',
        function (e) {
          _drag = true;
          self._dragSeek = true;
          var rect = self.progressTrack.getBoundingClientRect();
          if (isFinite(self.video.duration)) {
            self.video.currentTime = ((e.clientX - rect.left) / rect.width) * self.video.duration;
          }
          document.addEventListener('mousemove', onDrag, { signal: lifecycle.signal });
          document.addEventListener('mouseup', onEnd, { signal: lifecycle.signal });
        },
        { signal: lifecycle.signal },
      );
      function onDrag(e) {
        var rect = self.progressTrack.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (isFinite(self.video.duration)) {
          self.video.currentTime = pct * self.video.duration;
        }
        self.video.currentTime = pct * self.video.duration;
      }
      function onEnd() {
        _drag = false;
        self._dragSeek = false;
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', onEnd);
        if (self.hls && !self.isAuto()) self._relockQuality();
      }
    }

    // === Menus, Fullscreen, PiP, Doubl-tap, Keyboard, Controls hide ===
    if (this.speedBtn && this.speedMenu) {
      this.speedBtn.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          this.toggleMenu(this.speedMenu);
        },
        { signal: lifecycle.signal },
      );
    }
    if (this.qualityBtn && this.qualityMenu) {
      this.qualityBtn.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          this.toggleMenu(this.qualityMenu);
        },
        { signal: lifecycle.signal },
      );
    }
    if (this.fsBtn) {
      this.fsBtn.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          document.fullscreenElement ? document.exitFullscreen() : c.requestFullscreen()?.catch(() => {});
        },
        { signal: lifecycle.signal },
      );
    }
    if (this.pipBtn && 'pictureInPictureEnabled' in document) {
      this.pipBtn.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          document.pictureInPictureElement
            ? document.exitPictureInPicture()
            : v.requestPictureInPicture()?.catch(() => {});
        },
        { signal: lifecycle.signal },
      );
    }
    if (this.nextBtn && this.total > 1) {
      this.nextBtn.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          this.switchToNextVideo();
        },
        { signal: lifecycle.signal },
      );
    }

    // Mobile double-tap
    var _tap = null;
    c.addEventListener(
      'touchend',
      function (e) {
        if (e.target.closest('.video-controls')) return;
        if (_tap) {
          clearTimeout(_tap);
          _tap = null;
          var x = (e.changedTouches[0].clientX - c.getBoundingClientRect().left) / c.getBoundingClientRect().width;
          v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + (x < 0.5 ? -10 : 10)));
          self.showSwitchToast(x < 0.5 ? '-10s' : '+10s');
        } else {
          _tap = setTimeout(function () {
            _tap = null;
          }, 300);
        }
      },
      { signal: lifecycle.signal },
    );

    c.addEventListener('keydown', (e) => this.handleKeyboard(e), { signal: lifecycle.signal });

    let _hideTimer;
    c.addEventListener(
      'mousemove',
      () => {
        this.showControls();
        clearTimeout(_hideTimer);
        _hideTimer = setTimeout(() => this.hideControls(), 2500);
      },
      { signal: lifecycle.signal },
    );
    c.addEventListener(
      'mouseleave',
      () => {
        if (!v.paused) this.hideControls();
      },
      { signal: lifecycle.signal },
    );
  }

  togglePlay() {
    if (this.video.paused) {
      this.video.play()?.catch(() => {});
    } else {
      this.video.pause();
    }
  }

  updateProgress() {
    const v = this.video;
    if (!v.duration) return;
    // Only update time text + buffer here — RAF handles the smooth fill/thumb
    if (this.timeCur) this.timeCur.textContent = this.fmt(v.currentTime);
    if (this.progressBuffer && v.buffered.length > 0) {
      const bufEnd = v.buffered.end(v.buffered.length - 1);
      this.progressBuffer.style.width = (bufEnd / v.duration) * 100 + '%';
    }
    // RAF smooth interpolation (skips during drag)
    if (!v.paused && v.duration && !this._dragSeek) {
      if (!this._rafId) {
        const self = this;
        let _lastTime = v.currentTime;
        let _lastWall = performance.now();
        const step = () => {
          if (self.video.paused || self._dragSeek) {
            self._rafId = null;
            return;
          }
          // Sync anchor point every ~250ms from actual currentTime to avoid drift
          if (performance.now() - _lastWall > 250) {
            _lastTime = self.video.currentTime;
            _lastWall = performance.now();
          }
          const estimated = Math.min(v.duration, _lastTime + (performance.now() - _lastWall) / 1000);
          const rpct = (estimated / v.duration) * 100;
          if (self.progressFill) self.progressFill.style.width = rpct + '%';
          if (self.progressThumb) self.progressThumb.style.left = rpct + '%';
          self._rafId = requestAnimationFrame(step);
        };
        this._rafId = requestAnimationFrame(step);
      }
    } else {
      if (this._rafId) {
        cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }
      // Show exact position when paused
      if (v.paused && v.duration) {
        const pct = (v.currentTime / v.duration) * 100;
        if (this.progressFill) this.progressFill.style.width = pct + '%';
        if (this.progressThumb) this.progressThumb.style.left = pct + '%';
      }
    }
  }

  showControls() {
    if (this.controls) {
      this.controls.style.opacity = '1';
      this.controls.style.pointerEvents = 'auto';
    }
  }

  hideControls() {
    if (this.controls) {
      this.controls.style.opacity = '0';
      this.controls.style.pointerEvents = 'none';
    }
  }

  toggleMenu(menu) {
    const isOpen = menu.classList.contains('open');
    // Close all menus
    if (this.speedMenu) this.speedMenu.classList.remove('open');
    if (this.qualityMenu) this.qualityMenu.classList.remove('open');
    if (!isOpen) menu.classList.add('open');
  }

  switchToNextVideo() {
    const nextIdx = (this.index + 1) % this.total;
    const nextPlayer = registry.players[nextIdx];
    if (nextPlayer && nextPlayer.video) {
      this.video.pause();
      nextPlayer.container.scrollIntoView({ behavior: 'smooth', block: 'center' });
      nextPlayer.video.play()?.catch(() => {});
    }
  }

  showOverlay(text, _type) {
    // Remove existing overlay if any
    const existing = this.container.querySelector('.video-key-overlay');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'video-key-overlay';
    el.style.cssText =
      'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:10;' +
      'background:rgba(0,0,0,0.7);color:#fff;padding:12px 20px;border-radius:10px;font-size:16px;font-weight:600;' +
      'text-align:center;white-space:pre-line;transition:opacity 0.3s';
    el.innerHTML = text;
    this.container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 1200);
  }

  handleKeyboard(e) {
    // Only handle if this container is focused or contains focus
    if (!this.container.contains(document.activeElement) && document.activeElement !== document.body) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (!isFinite(this.video.duration)) break;
        this.video.currentTime = Math.max(0, this.video.currentTime - 5);
        this.showOverlay('<i class=\"ri-rewind-fill\" style=\"font-size:24px\"></i><br>后退 5s');
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (!isFinite(this.video.duration)) break;
        this.video.currentTime = Math.min(this.video.duration, this.video.currentTime + 5);
        this.showOverlay('<i class=\"ri-speed-fill\" style=\"font-size:24px\"></i><br>快进 5s');
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.video.volume = Math.min(1, Math.round((this.video.volume + 0.1) * 10) / 10);
        this.showOverlay(
          '<i class=\"ri-volume-up-fill\" style=\"font-size:24px\"></i><br>' +
            Math.round(this.video.volume * 100) +
            '%',
        );
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.video.volume = Math.max(0, Math.round((this.video.volume - 0.1) * 10) / 10);
        this.showOverlay(
          '<i class=\"ri-volume-down-fill\" style=\"font-size:24px\"></i><br>' +
            Math.round(this.video.volume * 100) +
            '%',
        );
        break;
      case 'f':
        if (document.fullscreenElement) document.exitFullscreen();
        else this.container.requestFullscreen()?.catch(() => {});
        break;
      case 'n':
        if (this.total > 1) this.switchToNextVideo();
        break;
      case 'm':
        this.video.muted = !this.video.muted;
        break;
    }
  }

  fmt(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }
}
Object.assign(VideoPlayer.prototype, qualityControls);
export { VideoPlayer };
