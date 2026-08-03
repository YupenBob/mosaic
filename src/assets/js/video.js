/**
 * Custom video player with full control UI.
 * Controls: play/pause, progress bar, time, speed, quality, next, fullscreen.
 */
import { $, $$ } from './utils.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const RES_ORDER = ['1080p', '720p', '480p', '360p'];

let allPlayers = [];
let _logLevel = 'info'; // debug | info | warn | error

function vlog(level, msg) {
  const order = { debug:0, info:1, warn:2, error:3 };
  if ((order[level] || 0) >= (order[_logLevel] || 0)) {
    console.log('[Video ' + level.toUpperCase() + '] ' + msg);
  }
}

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
  // Items may be in wrap (old inline) or in page-level .post-playlist-panel
  const items = document.querySelectorAll('.post-playlist-panel .pl-item, .video-playlist-wrap .pl-item');
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
      this.sources = { '360p': hlsSource.src, '480p': hlsSource.src, '720p': hlsSource.src, '1080p': hlsSource.src };
      this.currentRes = 'auto'; // Default to ABR
      // ABR start estimate: match the stored preference so playback starts at
      // the right tier instead of ramping up from the lowest one.
      var storedPref = (function() { try { return localStorage.getItem('mosaic_video_quality'); } catch { return null; } })();
      var defaultEstimate = 2500000;
      if (storedPref === '1080p') defaultEstimate = 6000000;
      else if (storedPref === '720p') defaultEstimate = 3000000;
      else if (storedPref === '480p') defaultEstimate = 1500000;
      else if (storedPref === '360p') defaultEstimate = 800000;
      try {
        this.hls = new window.Hls({
          maxBufferLength: 60,
          maxMaxBufferLength: 300,
          backBufferLength: 30,
          startLevel: -1,
          enableWorker: true,
          startFragPrefetch: true,
          capLevelToPlayerSize: true,
          abrEwmaDefaultEstimate: defaultEstimate,
          fragLoadingMaxRetry: 6,
        });
        vlog('info', 'HLS init: loading ' + hlsSource.src);
        this.hls.loadSource(hlsSource.src);
        this.hls.attachMedia(this.video);
        // Expose the Hls instance on the element (debugging/tests)
        this.video._hls = this.hls;
        var self = this;
        this.hls.on('hlsManifestParsed', function() {
          vlog('info', 'HLS manifest loaded: ' + (self.hls.levels||[]).length + ' levels, ' + ((self.hls.levels||[]).map(function(l){ return l.height + 'p'; }).join(', ')));
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
          // Apply a stored manual preference so playback starts at that tier
          if (storedPref && ['360p','480p','720p','1080p','4K'].indexOf(storedPref) >= 0) {
            var want = parseInt(storedPref) || 0;
            var sidx = (self.hls.levels || []).findIndex(function(l) { return l.height === want; });
            if (sidx >= 0) {
              self.currentRes = storedPref;
              self.hls.loadLevel = sidx;
              self.hls.nextLevel = sidx;
              vlog('info', 'Stored quality applied: ' + storedPref + ' (level ' + sidx + ')');
              self.updateQualityActive();
            }
          }
        });
        // Quality switch completion event
        this.hls.on('hlsLevelSwitched', function(event, data) {
          clearTimeout(self._switchFailTimer);
          self._switching = false;
          var level = self.hls.levels[data.level];
          if (level) {
            var h = level.height || 0;
            var label = h >= 2160 ? '4K' : h + 'p';
            vlog('info', 'Level switched to ' + label + ' (h='+h+')');
            if (!self.isAuto()) { self.currentRes = label; }
            self.updateQualityActive();
            // Only toast on manual switches; automatic ABR changes stay quiet
            if (!self.isAuto()) self.showSwitchToast('Switched to ' + label);
          }
        });
        this.hls.on('hlsError', function(event, data) {
          vlog('error', 'HLS error: ' + data.type + ' - ' + (data.details||''));
          if (data.fatal) { vlog('error', 'HLS FATAL — playback may stop'); }
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
      this.timeCur.addEventListener('click', () => {
        if (!isFinite(this.video.currentTime)) return;
        const ts = this.fmt(this.video.currentTime);
        navigator.clipboard?.writeText(ts).then(() => this.showOverlay('复制成功 ' + ts)).catch(() => {});
      });
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
    var self = this;
    document.addEventListener('visibilitychange', function() {
      if (document.hidden && self._rafId) { cancelAnimationFrame(self._rafId); self._rafId = null; }
    });

    // Events
    this.bindEvents();

    // Show controls on load
    this.showControls();
  }

  detectResolution() {
    // Check stored preference first
    try {
      const stored = localStorage.getItem('mosaic_video_quality');
      if (stored && ['360p','480p','720p','1080p'].includes(stored)) return stored;
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
      var label = (this.currentRes === 'auto' || !this.currentRes) ? 'Auto' : this.currentRes;
      this.qualityBtn.innerHTML = label + ' <i class="ri-arrow-down-s-line"></i>';
    }
  }


  isAuto() { return this.currentRes === 'auto'; }

  _relockQuality() {
    const targetH = parseInt(this.currentRes);
    if (isNaN(targetH)) return;
    const idx = (this.hls.levels||[]).findIndex(function(l){return l.height === targetH || l.height >= targetH;});
    if (idx >= 0) { this.hls.loadLevel = idx; this.hls.nextLevel = idx; }
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
    this._toastTimer = setTimeout(function() { el.classList.remove('show'); }, 2000);
  }

  switchResolution(res) {
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
    this._unlockTimer = setTimeout(function() { self._switching = false; }, 3000);

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
        let idx = levels.findIndex(function(l) { return l.height === targetH; });
        if (idx < 0 && levels.length > 0) {
          idx = levels.findIndex(function(l) { return l.height >= targetH; });
        }
        if (idx >= 0) {
          this.hls.loadLevel = idx;
          this.hls.nextLevel = idx;
          // Setting loadLevel/nextLevel locks the tier (ABR disabled in hls.js)
          vlog('info', 'loadLevel=' + idx + ', ABR disabled');
        }
      }
    } else {
      if (!this.sources[res]) { this._switching = false; return; }
      this.video.querySelectorAll('source').forEach((s) => s.remove());
      this.video.src = this.sources[res];
      this.video.load();
      const onReady = () => {
        this._switching = false;
        try { this.video.currentTime = time; } catch {}
        if (!this.video.paused) this.video.play()?.catch(() => {});
      };
      this.video.addEventListener('canplay', onReady, { once: true });
    }
    this.updateQualityActive();
    try { localStorage.setItem('mosaic_video_quality', res); } catch {}
  }

  bindEvents() {
    const v = this.video;
    const c = this.container;
    const self = this;

    // === Core playback events (merged) ===
    if (this.bigPlay) { this.bigPlay.addEventListener('click', (e) => { e.stopPropagation(); this.togglePlay(); }); }
    c.addEventListener('click', (e) => { if (!e.target.closest('.video-controls, .video-big-play')) this.togglePlay(); });
    if (this.playBtn) { this.playBtn.addEventListener('click', (e) => { e.stopPropagation(); this.togglePlay(); }); }

    v.addEventListener('play', () => { c.classList.add('playing'); c.classList.remove('paused'); if (this.playBtn) this.playBtn.innerHTML = '<i class="ri-pause-fill"></i>'; });
    v.addEventListener('pause', () => { c.classList.add('paused'); c.classList.remove('playing'); if (this.playBtn) this.playBtn.innerHTML = '<i class="ri-play-fill"></i>'; });
    v.addEventListener('loadedmetadata', () => { if (this.timeDur) this.timeDur.textContent = this.fmt(v.duration); });

    // Merged timeupdate: progress + freeze detect + position save
    var _stuckCount = 0;
    v.addEventListener('timeupdate', () => {
      this.updateProgress();
      // Freeze detection
      if (v.readyState < 3 && !v.paused) { _stuckCount++; if (_stuckCount >= 5) c.classList.add('buffering'); }
      else { _stuckCount = 0; c.classList.remove('buffering'); }
      // Save position
      try { if (v.currentTime > 1) localStorage.setItem('mosaic_video_pos_' + (v.src||'').slice(-40), v.currentTime); } catch {}
    });

    // Merged waiting: spinner + adaptive downgrade
    var _waitingTimer = null;
    v.addEventListener('waiting', () => {
      c.classList.add('buffering'); vlog('warn', 'Buffering...');
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
    });
    v.addEventListener('canplay', () => { c.classList.remove('buffering'); });
    v.addEventListener('playing', () => { c.classList.remove('buffering'); _waitingTimer && clearTimeout(_waitingTimer); });
    v.addEventListener('ended', () => { c.dispatchEvent(new CustomEvent('video-ended', { bubbles: true })); });

    // Volume
    v.addEventListener('volumechange', () => {
      try { localStorage.setItem('mosaic_video_volume', v.volume); } catch {}
      if (this.volumeBtn) this.volumeBtn.innerHTML = v.muted || v.volume === 0 ? '<i class="ri-volume-mute-line"></i>' : v.volume < 0.5 ? '<i class="ri-volume-down-line"></i>' : '<i class="ri-volume-up-line"></i>';
      if (this.volumeRange) this.volumeRange.value = Math.round(v.volume * 100);
    });
    if (this.volumeBtn) { this.volumeBtn.addEventListener('click', (e) => { e.stopPropagation(); v.muted = !v.muted; }); }
    if (this.volumeRange) { this.volumeRange.addEventListener('input', (e) => { e.stopPropagation(); v.volume = e.target.value / 100; v.muted = false; }); }

    // === Progress bar (click, hover, drag) ===
    if (this.progressTrack) {
      this.progressTrack.addEventListener('click', (e) => {
        const rect = this.progressTrack.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        if (!isFinite(v.duration)) return;
        v.currentTime = pct * v.duration;
        if (this.progressFill) this.progressFill.style.width = (pct * 100) + '%';
        if (this.progressThumb) this.progressThumb.style.left = (pct * 100) + '%';
        // Re-lock quality after click-seek
        if (self.hls && !self.isAuto()) self._relockQuality();
      });
      this.progressTrack.addEventListener('mousemove', (e) => {
        const rect = this.progressTrack.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        if (this.progressTooltip && isFinite(v.duration)) { this.progressTooltip.textContent = this.fmt(v.duration * pct); this.progressTooltip.style.left = (pct * 100) + '%'; this.progressTooltip.style.opacity = '1'; }
      });
      this.progressTrack.addEventListener('mouseleave', () => {
        if (this.progressTooltip) this.progressTooltip.style.opacity = '0';
      });
      // Drag seek — supresses RAF smooth animation during drag
      var _drag = false;
      this.progressTrack.addEventListener('mousedown', function(e) {
        _drag = true; self._dragSeek = true;
        var rect = self.progressTrack.getBoundingClientRect();
        if (isFinite(self.video.duration)) { self.video.currentTime = ((e.clientX - rect.left) / rect.width) * self.video.duration; }
        document.addEventListener('mousemove', onDrag); document.addEventListener('mouseup', onEnd);
      });
      function onDrag(e) {
        var rect = self.progressTrack.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (isFinite(self.video.duration)) { self.video.currentTime = pct * self.video.duration; }
        self.video.currentTime = pct * self.video.duration;
      }
      function onEnd() { _drag = false; self._dragSeek = false; document.removeEventListener('mousemove', onDrag); document.removeEventListener('mouseup', onEnd);
        if (self.hls && !self.isAuto()) self._relockQuality();
      }
    }

    // === Menus, Fullscreen, PiP, Doubl-tap, Keyboard, Controls hide ===
    if (this.speedBtn && this.speedMenu) { this.speedBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMenu(this.speedMenu); }); }
    if (this.qualityBtn && this.qualityMenu) { this.qualityBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMenu(this.qualityMenu); }); }
    if (this.fsBtn) { this.fsBtn.addEventListener('click', (e) => { e.stopPropagation(); document.fullscreenElement ? document.exitFullscreen() : c.requestFullscreen()?.catch(()=>{}); }); }
    if (this.pipBtn && 'pictureInPictureEnabled' in document) { this.pipBtn.addEventListener('click', (e) => { e.stopPropagation(); document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture()?.catch(()=>{}); }); }
    if (this.nextBtn && this.total > 1) { this.nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.switchToNextVideo(); }); }

    // Mobile double-tap
    var _tap = null;
    c.addEventListener('touchend', function(e) {
      if (e.target.closest('.video-controls')) return;
      if (_tap) { clearTimeout(_tap); _tap = null;
        var x = (e.changedTouches[0].clientX - c.getBoundingClientRect().left) / c.getBoundingClientRect().width;
        v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + (x < 0.5 ? -10 : 10)));
        self.showSwitchToast(x < 0.5 ? '-10s' : '+10s');
      } else { _tap = setTimeout(function() { _tap = null; }, 300); }
    });

    c.addEventListener('keydown', (e) => this.handleKeyboard(e));

    let _hideTimer;
    c.addEventListener('mousemove', () => { this.showControls(); clearTimeout(_hideTimer); _hideTimer = setTimeout(() => this.hideControls(), 2500); });
    c.addEventListener('mouseleave', () => { if (!v.paused) this.hideControls(); });
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
          if (self.video.paused || self._dragSeek) { self._rafId = null; return; }
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
      if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
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
    const nextPlayer = allPlayers[nextIdx];
    if (nextPlayer && nextPlayer.video) {
      this.video.pause();
      nextPlayer.container.scrollIntoView({ behavior: 'smooth', block: 'center' });
      nextPlayer.video.play()?.catch(() => {});
    }
  }

  showOverlay(text, type) {
    // Remove existing overlay if any
    const existing = this.container.querySelector('.video-key-overlay');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'video-key-overlay';
    el.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:10;'
      + 'background:rgba(0,0,0,0.7);color:#fff;padding:12px 20px;border-radius:10px;font-size:16px;font-weight:600;'
      + 'text-align:center;white-space:pre-line;transition:opacity 0.3s';
    el.innerHTML = text;
    this.container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 1200);
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
        this.showOverlay('<i class=\"ri-volume-up-fill\" style=\"font-size:24px\"></i><br>' + Math.round(this.video.volume * 100) + '%');
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.video.volume = Math.max(0, Math.round((this.video.volume - 0.1) * 10) / 10);
        this.showOverlay('<i class=\"ri-volume-down-fill\" style=\"font-size:24px\"></i><br>' + Math.round(this.video.volume * 100) + '%');
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
