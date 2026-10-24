/**
 * Media-element event plumbing for the playback controller: element/document
 * listeners, position persistence, queued play attempts, stall handling and
 * lifecycle (visibility/pagehide) behaviour.
 *
 * Exposed as a mixin consumed by `playback.js`.
 */

export const mediaEvents = {
  _bindVideo() {
    const video = this.video;
    const signal = this._abort?.signal;
    const add = (target, type, handler, options = {}) => {
      try {
        target.addEventListener(type, handler, { ...options, ...(signal ? { signal } : {}) });
      } catch {
        /* detached */
      }
    };
    // Play intent is replayed on readiness events: this fixes the first-click
    // MSE attach race where video.play() rejected before a source existed.
    add(video, 'loadedmetadata', () => this._onMetadata());
    add(video, 'canplay', () => {
      if (this._state === 'stalled') this._setState('ready');
      if (this._playIntent && video.paused && !this._attemptingPlay) this._attemptPlay();
    });
    add(video, 'playing', () => {
      this._attemptingPlay = false;
      this._retryCount = 0;
      this._cancelTimer('stall');
      this._cancelTimer('playRetry');
      this._setState('playing');
      this._emit('playing');
    });
    add(video, 'pause', () => {
      if (this._destroyed) return;
      this._persistPosition(true);
      if (this._state === 'playing' || this._state === 'loading' || this._state === 'stalled') {
        this._setState('ready');
      }
      this._emit('paused');
      this._scheduleStopLoad();
    });
    add(video, 'waiting', () => {
      if (this._destroyed) return;
      this._setState('stalled');
      this._emit('stalled', { duration: 0 });
      this._armStallTimer();
    });
    add(video, 'timeupdate', () => {
      this._persistPosition(false);
      this._emit('timeupdate', { time: video.currentTime });
    });
    add(video, 'seeking', () => this._emit('seeking'));
    add(video, 'seeked', () => {
      this._emit('seeked');
      if (this._manual && this._hls) this._applyLevel(this._levels.findIndex((l) => l.label === this._manual));
    });
    add(video, 'ended', () => {
      this._persistPosition(true);
      this._setState('ready');
      this._emit('ended');
    });
    add(video, 'volumechange', () => this._emit('volumechange'));
    add(video, 'error', () => this._onMediaError());
  },

  _bindPageLifecycle() {
    if (typeof document === 'undefined') return;
    const signal = this._abort?.signal;
    const add = (target, type, handler) => {
      try {
        target.addEventListener(type, handler, signal ? { signal } : false);
      } catch {
        /* detached */
      }
    };
    add(document, 'visibilitychange', () => {
      if (this._destroyed) return;
      if (document.hidden) {
        this._resumeOnVisible = !this.video.paused;
        if (this._resumeOnVisible) this.video.pause();
        this._persistPosition(true);
        this._stopLoadWhenIdle(true);
      } else if (this._resumeOnVisible) {
        this._resumeOnVisible = false;
        this._emit('resume');
        this.play();
      }
    });
    add(window, 'pagehide', () => {
      this._persistPosition(true);
      this._stopLoadWhenIdle(true);
      if (this._state === 'playing') {
        try {
          this.video.pause();
        } catch {
          /* detached */
        }
      }
      this._emit('pagehide');
    });
    add(window, 'pageshow', () => this._emit('pageshow'));
  },

  /** Restore the saved position once duration is known (never before metadata). */
  _onMetadata() {
    if (this._destroyed) return;
    if (!this._restored) {
      this._restored = true;
      const saved = parseFloat(globalThis.localStorage?.getItem?.(this.positionKey));
      const duration = this.video.duration;
      if (this.options.resume !== false && saved > 1 && (!Number.isFinite(duration) || saved < duration - 0.5)) {
        try {
          this.video.currentTime = saved;
          this._emit('restored', { position: saved });
        } catch {
          /* seeking not allowed yet */
        }
      }
    }
    this._applyPendingSeek();
  },

  _applyPendingSeek() {
    if (this._pendingSeek == null) return;
    const value = this._pendingSeek;
    this._pendingSeek = null;
    try {
      this.video.currentTime = value;
      this._emit('seek', { time: value });
    } catch {
      /* not seekable yet */
    }
  },

  _attemptPlay() {
    if (this._destroyed || !this._playIntent) return;
    const video = this.video;
    if (!video.paused) {
      this._setState('playing');
      return;
    }
    if (this._mode === 'idle' || this._mode === 'attaching') return;
    // HLS cannot play before the intent-gated manifest arrived; _onManifest will
    // call startFragments and the canplay handler replays the play intent.
    if (this._mode === 'hls' && !this._manifestReady) return;
    this._attemptingPlay = true;
    let result;
    try {
      result = video.play();
    } catch (error) {
      this._attemptingPlay = false;
      this._playFailed(error);
      return;
    }
    if (!result || typeof result.then !== 'function') {
      this._attemptingPlay = false;
      return;
    }
    result
      .then(() => {
        this._attemptingPlay = false;
      })
      .catch((error) => {
        this._attemptingPlay = false;
        this._playFailed(error);
      });
  },

  _playFailed(error) {
    if (this._destroyed || !this._playIntent) return;
    const name = String(error?.name || '');
    if (name === 'AbortError') return; // superseded by pause()
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      this._emit('blocked', { error });
      this._setState('ready');
      return;
    }
    this._retryCount += 1;
    if (this._retryCount > 3) {
      this._retryCount = 0;
      if (this._mode === 'hls') this._fallback('play-failed');
      else this._emit('error', { fatal: true, details: 'play-failed', error });
      return;
    }
    this._timer(
      'playRetry',
      () => {
        if (this._destroyed || !this._playIntent || !this.video.paused) return;
        this._attemptPlay();
      },
      250 * this._retryCount,
    );
  },

  _onMediaError() {
    if (this._destroyed) return;
    const mediaError = this.video.error;
    const details = mediaError ? `media-error-${mediaError.code}` : 'media-error';
    this._emit('error', { fatal: true, details, error: mediaError || null });
    if (this._mode === 'hls') {
      if (this._hls) {
        try {
          this._hls.recoverMediaError?.();
          return;
        } catch {
          /* fall through to progressive */
        }
      }
      this._fallback('media-error');
      return;
    }
    const tiers = Array.from(this._levels);
    const index = tiers.findIndex((tier) => tier.label === this._currentLevel?.label);
    if (!this._manual && index > 0) {
      this._switchProgressive(tiers[index - 1]);
      return;
    }
    this._setState('ready');
  },

  // ---- stalls / buffers ---------------------------------------------------

  _armStallTimer() {
    this._stallStart = Date.now();
    this._timer(
      'stall',
      () => {
        if (this._destroyed || !this.video || this.video.paused || this.video.readyState >= 3) return;
        this._emit('stalled', { duration: Date.now() - this._stallStart });
        this._degradeQuality();
      },
      2500,
    );
  },

  _handleStall() {
    if (this._destroyed) return;
    this._setState('stalled');
    this._armStallTimer();
  },

  /** One step down for automatic modes only; manual quality is a promise. */
  _degradeQuality() {
    if (this._manual) return;
    if (this._mode === 'hls' && this._hls) {
      const current = Number.isInteger(this._hls.currentLevel) ? this._hls.currentLevel : this._currentLevel?.index;
      if (Number.isInteger(current) && current > 0) {
        try {
          this._hls.autoLevelCapping = current - 1;
        } catch {
          return;
        }
        this._emit('downgrade', { mode: 'hls', capping: current - 1 });
        this._timer(
          'capReset',
          () => {
            if (this._hls) this._hls.autoLevelCapping = -1;
          },
          20000,
        );
      }
      return;
    }
    const tiers = this._levels;
    const index = tiers.findIndex((tier) => tier.label === this._currentLevel?.label);
    if (index > 0) this._switchProgressive(tiers[index - 1]);
  },

  /** Paused players stop fetching after a grace period (Save-Data / mobile radios). */
  _scheduleStopLoad() {
    this._timer(
      'stopLoad',
      () => {
        if (this._destroyed || !this.video.paused || this._playIntent) return;
        this._stopLoadWhenIdle(true);
      },
      5000,
    );
  },

  _stopLoadWhenIdle(force) {
    if (!this._hls || !this._loadStarted) return;
    if (!force && (!this.video.paused || this._playIntent)) return;
    try {
      if (typeof this._hls.stopLoad === 'function') this._hls.stopLoad();
    } catch {
      return;
    }
    this._loadStarted = false;
    this._fatalCount = 0;
    this._emit('loadingstop');
  },

  /** Throttled position persistence under the stable media key. */
  _persistPosition(force) {
    const video = this.video;
    const time = Number(video?.currentTime);
    if (!Number.isFinite(time)) return;
    const duration = Number(video.duration);
    if (duration > 0 && time >= duration - 0.5) {
      try {
        globalThis.localStorage?.removeItem?.(this.positionKey);
      } catch {
        /* private mode */
      }
      return;
    }
    if (time <= 1) return;
    const now = Date.now();
    if (!force && now - this._lastPersist < 1000) return;
    this._lastPersist = now;
    try {
      globalThis.localStorage?.setItem?.(this.positionKey, String(Math.round(time)));
    } catch {
      /* private mode */
    }
  },

  _deriveMediaId() {
    const candidate = this._hlsUrl || Object.values(this._sources)[0] || '';
    try {
      return new URL(candidate, 'http://localhost').pathname;
    } catch {
      return candidate || 'video';
    }
  },
};
