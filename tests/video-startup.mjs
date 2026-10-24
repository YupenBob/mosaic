/**
 * Video startup policy: the published-tier start level from configuration is
 * honoured by the unified decode controller, manual preferences win, and the
 * automatic path never locks ABR.
 *
 * Run: node tests/video-startup.mjs
 */
import assert from 'node:assert/strict';
import { normalizeConfig, validateConfig } from '../shared/config.mjs';

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

class FakeHls {
  static isSupported() {
    return true;
  }
  constructor(options) {
    this.options = options;
    this.startLevel = options.startLevel;
    this.levels = [
      { height: 240, bitrate: 250000 },
      { height: 360, bitrate: 500000 },
      { height: 480, bitrate: 900000 },
    ];
    this.events = {};
    this.destroyed = false;
  }
  on(event, handler) {
    this.events[event] = handler;
  }
  loadSource() {}
  attachMedia() {}
  startLoad() {}
  recoverMediaError() {}
  destroy() {
    this.destroyed = true;
  }
  emit(event, payload) {
    this.events[event]?.(event, payload);
  }
}

class FakeVideo {
  constructor() {
    this.listeners = new Map();
    this.paused = true;
    this.currentTime = 0;
    this.duration = NaN;
    this.dataset = { mediaId: 'fixture/videos/a.mp4' };
    this.poster = '';
  }
  closest() {
    return null;
  }
  getAttribute() {
    return null;
  }
  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }
  removeEventListener() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
}

function start(config, preference = null) {
  store.clear();
  if (preference) store.set('mosaic_video_quality', preference);
  globalThis.window = {
    __MOSAIC_CONFIG: config,
    Hls: FakeHls,
    devicePixelRatio: 1,
    innerWidth: 1280,
    matchMedia: () => ({ matches: false }),
  };
  const video = new FakeVideo();
  globalThis.document = { hidden: false, addEventListener() {} };
  // Imported once; the controller reads the injected config per instance.
  const { createPlayback } = playbackModule;
  const playback = createPlayback({ video, hls: 'https://fixture.test/master.m3u8' });
  playback.attach();
  playback.hls.emit('hlsManifestParsed');
  return playback;
}

const playbackModule = await import('../src/assets/js/video/playback.js');

try {
  const config = normalizeConfig();
  assert.deepEqual(validateConfig(config), [], 'default config is valid');

  const automatic = start(config);
  assert.equal(automatic.hls.startLevel, 0, 'automatic playback starts at the lowest published tier');
  assert.equal(automatic.hls.loadLevel, undefined, 'startup tier does not lock automatic adaptation');
  assert.equal(automatic.hls.options.autoStartLoad, false, 'fragments never load before an explicit play intent');

  assert.equal(start(normalizeConfig({ player: { hls: { startLevel: 1 } } })).hls.startLevel, 1);
  assert.equal(start(normalizeConfig({ player: { hls: { startLevel: -1 } } })).hls.startLevel, -1);

  const manualLow = start(config, '240p');
  assert.equal(manualLow.hls.loadLevel, 0, 'manual 240p preference is retained');
  assert.equal(manualLow.quality, '240p');
  const manualHigh = start(config, '480p');
  assert.equal(manualHigh.hls.loadLevel, 2);
  assert.equal(manualHigh.quality, '480p');

  const unavailable = start(config, '4K');
  assert.equal(unavailable.hls.loadLevel, undefined, 'an unavailable preference keeps adaptation');
  assert.equal(unavailable.hls.startLevel, 0);
  assert.equal(unavailable.quality, 'auto');

  // An explicit per-player quality option wins over the stored preference.
  store.clear();
  store.set('mosaic_video_quality', '480p');
  globalThis.window = {
    __MOSAIC_CONFIG: normalizeConfig(),
    Hls: FakeHls,
    devicePixelRatio: 1,
    innerWidth: 1280,
    matchMedia: () => ({ matches: false }),
  };
  globalThis.document = { hidden: false, addEventListener() {} };
  const explicit = playbackModule.createPlayback({
    video: new FakeVideo(),
    hls: 'https://fixture.test/master.m3u8',
    quality: '360p',
  });
  explicit.attach();
  explicit.hls.emit('hlsManifestParsed');
  assert.equal(explicit.hls.loadLevel, 1, 'explicit quality option wins over persisted preference');
  assert.equal(explicit.quality, '360p');
  explicit.destroy();

  console.log('Video startup: configurable initial tier, automatic adaptation and published manual preferences passed');
} finally {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.localStorage;
}
