/** HLS setup, adaptive levels and recovery. */
export function initHls(hlsSource, log) {
  if (this.isHLS && hlsSource && typeof window.Hls !== 'undefined' && window.Hls.isSupported?.() !== false) {
    // Pre-set sources so quality menu shows immediately
    // Sources come from the manifest-backed MP4 elements until HLS levels load.
    this.currentRes = 'auto'; // Default to ABR
    // ABR start estimate: match the stored preference so playback starts at
    // the right tier instead of ramping up from the lowest one.
    var storedPref = (function () {
      try {
        return localStorage.getItem('mosaic_video_quality');
      } catch {
        return null;
      }
    })();
    var defaultEstimate = 2500000;
    if (storedPref === '1080p') defaultEstimate = 6000000;
    else if (storedPref === '720p') defaultEstimate = 3000000;
    else if (storedPref === '480p') defaultEstimate = 1500000;
    else if (storedPref === '360p') defaultEstimate = 800000;
    try {
      this.hls = new window.Hls({
        maxBufferLength: 90,
        maxMaxBufferLength: 300,
        backBufferLength: 30,
        startLevel: -1,
        enableWorker: true,
        startFragPrefetch: true,
        capLevelToPlayerSize: true,
        abrEwmaDefaultEstimate: defaultEstimate,
        fragLoadingMaxRetry: 6,
        fragLoadingTimeOut: 60000,
        manifestLoadingTimeOut: 60000,
        levelLoadingTimeOut: 60000,
        ...window.__MOSAIC_CONFIG?.player?.hls,
      });
      log('info', 'HLS init: loading ' + hlsSource.src);
      this.hls.loadSource(hlsSource.src);
      this.hls.attachMedia(this.video);
      // Expose the Hls instance on the element (debugging/tests)
      this.video._hls = this.hls;
      var self = this;
      this.hls.on('hlsManifestParsed', function () {
        if (!self.hls || self.lifecycle?.signal.aborted) return;
        log(
          'info',
          'HLS manifest loaded: ' +
            (self.hls.levels || []).length +
            ' levels, ' +
            (self.hls.levels || [])
              .map(function (l) {
                return l.height + 'p';
              })
              .join(', '),
        );
        self.sources = {};
        var levels = self.hls.levels || [];
        levels.forEach(function (level) {
          var h = level.height || 0;
          if (h === 0)
            h = level.bitrate > 12000000 ? 2160 : level.bitrate > 3000000 ? 1080 : level.bitrate > 1500000 ? 720 : 480;
          var label = h >= 2160 ? '4K' : h + 'p';
          self.sources[label] = hlsSource.src;
        });
        if (Object.keys(self.sources).length === 0) {
          self.sources = {};
        }
        if (self.qualityMenu) {
          self.qualityMenu.innerHTML = '';
          self.buildQualityMenu();
        }
        // Apply a stored manual preference so playback starts at that tier
        if (storedPref && ['360p', '480p', '720p', '1080p', '4K'].indexOf(storedPref) >= 0) {
          var want = storedPref === '4K' ? 2160 : parseInt(storedPref) || 0;
          var sidx = (self.hls.levels || []).findIndex(function (l) {
            return l.height === want;
          });
          if (sidx >= 0) {
            self.currentRes = storedPref;
            self.hls.loadLevel = sidx;
            self.hls.nextLevel = sidx;
            log('info', 'Stored quality applied: ' + storedPref + ' (level ' + sidx + ')');
            self.updateQualityActive();
          }
        } else {
          // No stored preference: start at a mid tier so the first frames
          // arrive quickly instead of probing up from the lowest level.
          var mid = Math.min(2, (self.hls.levels || []).length - 1);
          if (mid >= 0) self.hls.startLevel = mid;
        }
      });
      // Quality switch completion event
      this.hls.on('hlsLevelSwitched', function (event, data) {
        if (!self.hls || self.lifecycle?.signal.aborted) return;
        clearTimeout(self._switchFailTimer);
        self._switching = false;
        var level = self.hls.levels[data.level];
        if (level) {
          var h = level.height || 0;
          var label = h >= 2160 ? '4K' : h + 'p';
          log('info', 'Level switched to ' + label + ' (h=' + h + ')');
          if (!self.isAuto()) {
            self.currentRes = label;
          }
          self.updateQualityActive();
          // Only toast on manual switches; automatic ABR changes stay quiet
          if (!self.isAuto()) self.showSwitchToast('Switched to ' + label);
        }
      });
      this.hls.on('hlsError', function (event, data) {
        if (!self.hls || self.lifecycle?.signal.aborted) return;
        log('error', 'HLS error: ' + data.type + ' - ' + (data.details || ''));
        if (data.fatal) {
          self._fatalCount = (self._fatalCount || 0) + 1;
          log('error', 'HLS FATAL ' + data.type + ' (attempt ' + self._fatalCount + ')');
          try {
            if (self._fatalCount <= 2) {
              if (data.type === 'networkError') self.hls.startLoad();
              else if (data.type === 'mediaError') self.hls.recoverMediaError();
              else self.destroyHls();
            } else {
              // Two recovery attempts failed — degrade to MP4 instead of a
              // dead player.
              self.destroyHls();
            }
          } catch (e) {
            log('error', 'HLS recovery failed: ' + e.message);
            self.destroyHls();
          }
        }
      });
    } catch (e) {
      console.error('HLS init failed:', e);
      this.isHLS = false;
    }
  }
}
