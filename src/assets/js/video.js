/**
 * Custom video player with full control UI.
 * Controls: play/pause, progress bar, time, speed, quality, download, next, fullscreen.
 */
import { $, $$ } from './utils.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const RES_ORDER = ['1080p', '720p', '480p'];

let allPlayers = [];

let _globalClickBound = false;

export function initVideoPlayers() {
  // Single global click handler for closing menus (instead of per-instance)
  if (!_globalClickBound) {
    document.addEventListener('click', (e) => {
      allPlayers.forEach((p) => {
        if (p.speedMenu && !p.speedBtn?.contains(e.target) && !p.speedMenu.contains(e.target)) {
          p.speedMenu.classList.remove('open');
        }
        if (p.qualityMenu && !p.qualityBtn?.contains(e.target) && !p.qualityMenu.contains(e.target)) {
          p.qualityMenu.classList.remove('open');
        }
      });
    });
    _globalClickBound = true;
  }

  const playlistLayout = document.querySelector('.video-playlist-wrap');
  if (playlistLayout) {
    initPlaylistMode(playlistLayout);
    return;
  }

  // Stacked mode
  const containers = $$('.video-container');
  containers.forEach((container, idx) => {
    allPlayers.push(new VideoPlayer(container, idx, containers.length));
  });
}

function initPlaylistMode(wrap) {
  const containers = wrap.querySelectorAll('.video-container');
  const items = wrap.querySelectorAll('.pl-item');
  const toggle = wrap.querySelector('.playlist-bar-toggle');
  const bar = wrap.querySelector('.playlist-bar');
  const total = containers.length;
  let currentIdx = 0;
  let currentPlayer = null;

  function showVideo(idx) {
    if (currentPlayer) currentPlayer.video.pause();
    containers.forEach((c, i) => { c.style.display = i === idx ? '' : 'none'; });
    items.forEach((it, i) => it.classList.toggle('active', i === idx));
    currentIdx = idx;
    currentPlayer = new VideoPlayer(containers[idx], idx, total);
    allPlayers = [currentPlayer];
  }

  // Toggle playlist open/close
  toggle.addEventListener('click', () => bar.classList.toggle('open'));

  // Init first video
  showVideo(0);

  items.forEach((item) => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.index);
      if (idx !== currentIdx) showVideo(idx);
    });
  });

  // Auto-advance
  wrap.addEventListener('video-ended', () => {
    const next = (currentIdx + 1) % total;
    showVideo(next);
    setTimeout(() => { if (currentPlayer) currentPlayer.video.play()?.catch(() => {}); }, 300);
  });
}

class VideoPlayer {
  constructor(container, index, total) {
    this.container = container;
    this.video = container.querySelector('.video-element');
    if (!this.video) return;

    this.index = index;
    this.total = total || parseInt(container.dataset.total) || 1;

    // Parse sources (multi-res or single)
    this.sources = {};
    var sourceEls = container.querySelectorAll('source[data-res]');
    sourceEls.forEach(function(s) { this.sources[s.dataset.res] = s.src; }.bind(this));

    // Check for HLS
    var hlsSource = container.querySelector('source[type="application/x-mpegURL"]');
    this.isHLS = !!(hlsSource);
    this.hls = null;

    if (this.isHLS && hlsSource && typeof window.Hls !== 'undefined') {
      // Pre-set sources so quality menu shows immediately
      this.sources = { '480p': hlsSource.src, '720p': hlsSource.src, '1080p': hlsSource.src };
      this.currentRes = 'auto'; // Default to ABR
      try {
        this.hls = new window.Hls({
          maxBufferLength: 30,       // Only buffer 30s ahead
          maxMaxBufferLength: 60,    // Max 60s for fast connections
          startLevel: -1,            // Start from lowest quality
          capLevelToPlayerSize: true,  // Don't load 4K on small screens
        });
        this.hls.loadSource(hlsSource.src);
        this.hls.attachMedia(this.video);
        var self = this;
        this.hls.on('hlsManifestParsed', function() {
          self.sources = {};
          var levels = self.hls.levels || [];
          levels.forEach(function(level) {
            var h = level.height || 0;
            if (h === 0) h = level.bitrate > 12000000 ? 2160 : level.bitrate > 3000000 ? 1080 : level.bitrate > 1500000 ? 720 : 480;
            var label = h >= 2160 ? '4K' : h + 'p';
            self.sources[label] = hlsSource.src;
          });
          if (Object.keys(self.sources).length === 0) {
            self.sources = { '480p': hlsSource.src, '720p': hlsSource.src, '1080p': hlsSource.src };
          }
          if (self.qualityMenu) { self.qualityMenu.innerHTML = ''; self.buildQualityMenu(); }
        });
        // Quality switch completion event
        this.hls.on('hlsLevelSwitched', function(event, data) {
          var level = self.hls.levels[data.level];
          if (level) {
            var h = level.height || 0;
            var label = h >= 2160 ? '4K' : h + 'p';
            self.currentRes = self.isAuto() ? 'auto' : label;
            self.updateQualityActive();
            self.showSwitchToast('Switched to ' + label);
          }
        });
        this.hls.on('hlsError', function(event, data) {
          if (data.fatal) { console.error('HLS fatal:', data.type, data.details); }
        });
      } catch(e) { console.error('HLS init failed:', e); this.isHLS = false; }
    }

    // Initialize sources for non-HLS or HLS fallback
    if (!this.isHLS) {
      if (!sourceEls.length && this.video.src) this.sources.single = this.video.src;
      this.currentRes = this.detectResolution();
      if (sourceEls.length > 0 && this.sources[this.currentRes]) {
        sourceEls.forEach(function(s) { s.remove(); });
        this.video.src = this.sources[this.currentRes];
      }
    }

    // Restore preferences
    try {
      const storedSpeed = parseFloat(localStorage.getItem('mosaic_video_speed'));
      if (storedSpeed && SPEEDS.includes(storedSpeed)) this.video.playbackRate = storedSpeed;
      const storedVol = parseFloat(localStorage.getItem('mosaic_video_volume'));
      if (!isNaN(storedVol)) this.video.volume = Math.max(0, Math.min(1, storedVol));
    } catch {}

    // Cache elements
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
    this.downloadBtn = container.querySelector('.vc-download');
    this.nextBtn = container.querySelector('.vc-next');
    this.fsBtn = container.querySelector('.vc-fullscreen');

    // Build speed menu
    if (this.speedMenu) this.buildSpeedMenu();
    // Build quality menu
    if (this.qualityMenu) this.buildQualityMenu();
    // Set download link
    this.updateDownloadLink();

    // Events
    this.bindEvents();

    // Show controls on load
    this.showControls();
  }

  detectResolution() {
    // Check stored preference first
    try {
      const stored = localStorage.getItem('mosaic_video_quality');
      if (stored && ['480p','720p','1080p'].includes(stored)) return stored;
    } catch {}
    const w = window.innerWidth;
    const dpr = window.devicePixelRatio || 1;
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const isSlow = conn && (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g');
    if (isSlow) return '480p';
    if (w * dpr >= 1920) return '1080p';
    if (w * dpr >= 1280) return '720p';
    return '480p';
  }

  buildSpeedMenu() {
    SPEEDS.forEach((s) => {
      const btn = document.createElement('button');
      btn.textContent = s + 'x';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.video.playbackRate = s;
        this.speedBtn.innerHTML = s + 'x <i class="ri-arrow-down-s-line"></i>';
        this.speedMenu.classList.remove('open');
        this.updateSpeedMenuActive();
        try { localStorage.setItem('mosaic_video_speed', s); } catch {}
      });
      this.speedMenu.appendChild(btn);
    });
    this.updateSpeedMenuActive();
  }

  buildQualityMenu() {
    if (!this.qualityMenu) return;
    this.qualityMenu.innerHTML = '';
    // Auto option for HLS
    if (this.hls) {
      const abtn = document.createElement('button');
      abtn.textContent = 'Auto'; abtn.dataset.res = 'auto';
      abtn.addEventListener('click', (e) => { e.stopPropagation(); this.switchResolution('auto'); this.qualityMenu.classList.remove('open'); });
      this.qualityMenu.appendChild(abtn);
    }
    Object.keys(this.sources).forEach((res) => {
      if (res === 'single') return;
      const btn = document.createElement('button');
      btn.textContent = res;
      btn.dataset.res = res;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.switchResolution(res);
        this.qualityMenu.classList.remove('open');
      });
      this.qualityMenu.appendChild(btn);
    });
    this.updateQualityActive();
  }

  updateSpeedMenuActive() {
    const speed = this.video.playbackRate;
    if (this.speedBtn) this.speedBtn.innerHTML = speed + 'x <i class="ri-arrow-down-s-line"></i>';
    this.speedMenu.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', parseFloat(b.textContent) === speed);
    });
  }

  updateQualityActive() {
    if (!this.qualityMenu) return;
    this.qualityMenu.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.res === this.currentRes);
    });
    if (this.qualityBtn) {
      var label = this.currentRes === 'auto' ? 'Auto' : this.currentRes;
      this.qualityBtn.innerHTML = label + ' <i class="ri-arrow-down-s-line"></i>';
    }
  }

  updateDownloadLink() {
    if (!this.downloadBtn) return;
    const url = this.sources[this.currentRes] || this.video.src;
    this.downloadBtn.href = url;
  }

  isAuto() { return this.currentRes === 'auto'; }

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
    this._toastTimer = setTimeout(function() { el.classList.remove('show'); }, 2000);
  }

  switchResolution(res) {
    if (res === this.currentRes || this._switching) return;
    this._switching = true;
    const time = this.video.currentTime;
    this.currentRes = res;

    var label = res === 'auto' ? 'Auto' : res;
    this.showSwitchToast('Switching to ' + label + '...');

    if (this.hls) {
      // Clear old quality buffer by seeking to current position
      this.video.currentTime = time;
      if (res === 'auto') {
        this.hls.loadLevel = -1;
        this.hls.nextLevel = -1;
        this.hls.autoLevelCapping = -1;
      } else {
        const targetH = parseInt(res);
        const levels = this.hls.levels || [];
        let idx = levels.findIndex(function(l) { return l.height === targetH; });
        if (idx < 0 && levels.length > 0) {
          idx = levels.findIndex(function(l) { return l.height >= targetH; });
        }
        if (idx >= 0) {
          this.hls.loadLevel = idx;
          this.hls.nextLevel = idx;
          this.hls.autoLevelCapping = idx;
        }
      }
      this._switching = false;
    } else {
      // MP4: direct src change
      if (!this.sources[res]) { this._switching = false; return; }
      this.video.querySelectorAll('source').forEach((s) => s.remove());
      this.video.src = this.sources[res];
      this.video.load();
      const onReady = () => {
        this._switching = false;
        try { this.video.currentTime = time; } catch {}
        const wasPlaying = !this.video.paused;
        if (wasPlaying) this.video.play()?.catch(() => {});
      };
      this.video.addEventListener('canplay', onReady, { once: true });
    }
    this.updateQualityActive();
    this.updateDownloadLink();
    try { localStorage.setItem('mosaic_video_quality', res); } catch {}
  }

  bindEvents() {
    const v = this.video;
    const c = this.container;

    // Play/pause via big button
    if (this.bigPlay) {
      this.bigPlay.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePlay();
      });
    }

    // Click video area to toggle play (on container, not video element,
    // to ensure clicks are captured even through the overlay)
    c.addEventListener('click', (e) => {
      if (e.target.closest('.video-controls') || e.target.closest('.video-big-play')) return;
      this.togglePlay();
    });

    // Play/pause button
    if (this.playBtn) {
      this.playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePlay();
      });
    }

    // Update playback UI
    v.addEventListener('play', () => {
      c.classList.add('playing');
      c.classList.remove('paused');
      if (this.playBtn) this.playBtn.innerHTML = '<i class="ri-pause-fill"></i>';
    });
    v.addEventListener('pause', () => {
      c.classList.add('paused');
      c.classList.remove('playing');
      if (this.playBtn) this.playBtn.innerHTML = '<i class="ri-play-fill"></i>';
    });
    v.addEventListener('volumechange', () => {
      try { localStorage.setItem('mosaic_video_volume', v.volume); } catch {}
      if (this.volumeBtn) this.volumeBtn.innerHTML = v.muted || v.volume === 0 ? '<i class="ri-volume-mute-line"></i>' : v.volume < 0.5 ? '<i class="ri-volume-down-line"></i>' : '<i class="ri-volume-up-line"></i>';
      if (this.volumeRange) this.volumeRange.value = v.muted ? 0 : Math.round(v.volume * 100);
    });
    v.addEventListener('loadedmetadata', () => {
      if (this.timeDur) this.timeDur.textContent = this.fmt(v.duration);
    });

    // Loading spinner + auto-pause on stall
    v.addEventListener('waiting', () => {
      c.classList.add('buffering');
      // Auto-pause after 8 seconds of continuous buffering
      if (!this._stallTimer) {
        this._stallTimer = setTimeout(() => {
          v.pause();
          this.showSwitchToast('Buffering too long — paused');
        }, 8000);
      }
    });
    v.addEventListener('canplay', () => {
      c.classList.remove('buffering');
      if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null; }
    });
    v.addEventListener('playing', () => {
      c.classList.remove('buffering');
      if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null; }
    });

    // Progress & buffer
    v.addEventListener('timeupdate', () => this.updateProgress());
    if (this.progressTrack) {
      // Click to seek
      this.progressTrack.addEventListener('click', (e) => {
        const rect = this.progressTrack.getBoundingClientRect();
        v.currentTime = ((e.clientX - rect.left) / rect.width) * v.duration;
      });
      // Hover time preview
      this.progressTrack.addEventListener('mousemove', (e) => {
        const rect = this.progressTrack.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        const t = v.duration * pct;
        if (this.progressTooltip) {
          this.progressTooltip.textContent = this.fmt(t);
          this.progressTooltip.style.left = (pct * 100) + '%';
          this.progressTooltip.style.opacity = '1';
        }
      });
      this.progressTrack.addEventListener('mouseleave', () => {
        if (this.progressTooltip) this.progressTooltip.style.opacity = '0';
      });
      // Drag to seek
      var drag = false;
      var self = this;
      this.progressTrack.addEventListener('mousedown', function(e) {
        drag = true;
        var rect = self.progressTrack.getBoundingClientRect();
        self.video.currentTime = ((e.clientX - rect.left) / rect.width) * self.video.duration;
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', onEnd);
      });
      function onDrag(e) {
        if (!drag) return;
        var rect = self.progressTrack.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        self.video.currentTime = pct * self.video.duration;
      }
      function onEnd() { drag = false; document.removeEventListener('mousemove', onDrag); document.removeEventListener('mouseup', onEnd); }
    }

    // Volume
    if (this.volumeBtn) {
      this.volumeBtn.addEventListener('click', (e) => { e.stopPropagation(); v.muted = !v.muted; });
    }
    if (this.volumeRange) {
      this.volumeRange.addEventListener('input', (e) => { e.stopPropagation(); v.volume = e.target.value / 100; v.muted = false; });
    }

    // Speed button toggle
    if (this.speedBtn && this.speedMenu) {
      this.speedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMenu(this.speedMenu);
      });
    }

    // Quality button toggle
    if (this.qualityBtn && this.qualityMenu) {
      this.qualityBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMenu(this.qualityMenu);
      });
    }

    // Fullscreen
    if (this.fsBtn) {
      this.fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          c.requestFullscreen()?.catch(() => {});
        }
      });
    }

    // Next video
    if (this.nextBtn && this.total > 1) {
      this.nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.switchToNextVideo();
      });
    }

    // Keyboard
    c.addEventListener('keydown', (e) => this.handleKeyboard(e));

    // Auto-hide controls timer
    let hideTimer;
    c.addEventListener('mousemove', () => {
      this.showControls();
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => this.hideControls(), 2500);
    });
    c.addEventListener('mouseleave', () => {
      if (!v.paused) this.hideControls();
    });

    // Video ended → dispatch event for playlist auto-advance
    v.addEventListener('ended', () => {
      c.dispatchEvent(new CustomEvent('video-ended', { bubbles: true }));
    });

    // Adaptive quality: only auto-downgrade if NOT during manual switch
    // and only after 3 seconds of continuous waiting (not just buffering)
    let waitingTimer = null;
    v.addEventListener('waiting', () => {
      if (this._switching) return;
      waitingTimer = setTimeout(() => {
        const idx = RES_ORDER.indexOf(this.currentRes);
        if (idx < RES_ORDER.length - 1 && !this._switching) {
          const lower = RES_ORDER[idx + 1];
          if (this.sources[lower]) this.switchResolution(lower);
        }
      }, 3000);
    });
    v.addEventListener('playing', () => {
      if (waitingTimer) { clearTimeout(waitingTimer); waitingTimer = null; }
    });
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
    const pct = (v.currentTime / v.duration) * 100;
    if (this.progressFill) this.progressFill.style.width = pct + '%';
    if (this.progressThumb) this.progressThumb.style.left = pct + '%';
    if (this.timeCur) this.timeCur.textContent = this.fmt(v.currentTime);
    // Buffered progress
    if (this.progressBuffer && v.buffered.length > 0) {
      const bufEnd = v.buffered.end(v.buffered.length - 1);
      this.progressBuffer.style.width = (bufEnd / v.duration) * 100 + '%';
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
    const nextPlayer = allPlayers[nextIdx];
    if (nextPlayer && nextPlayer.video) {
      this.video.pause();
      nextPlayer.container.scrollIntoView({ behavior: 'smooth', block: 'center' });
      nextPlayer.video.play()?.catch(() => {});
    }
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
        this.video.currentTime = Math.max(0, this.video.currentTime - 5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.video.currentTime = Math.min(this.video.duration, this.video.currentTime + 5);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.video.volume = Math.min(1, this.video.volume + 0.1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.video.volume = Math.max(0, this.video.volume - 0.1);
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
