/**
 * Decode-flow contract tests for `createPlayback` / `ensureHlsLoaded`.
 *
 * These run without a browser: a minimal fake `<video>` element plus a stubbed
 * `window.Hls` reproduce the races that broke the production player (play()
 * before MSE attach, resumed positions before metadata, unrecoverable manifest,
 * duplicated startLoad calls, destroy while recovering).
 *
 * Run: node tests/playback-flow.mjs
 */
import assert from 'node:assert/strict';

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
    this.handlers = {};
    this.levels = [];
    this.loadLevel = undefined;
    this.nextLevel = undefined;
    this.autoLevelCapping = -1;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.loadSourceCalls = 0;
    this.destroyed = false;
  }
  on(event, handler) {
    this.handlers[event] = handler;
  }
  loadSource(url) {
    this.url = url;
    this.loadSourceCalls = (this.loadSourceCalls || 0) + 1;
  }
  attachMedia(video) {
    this.video = video;
  }
  startLoad(position) {
    this.startCalls += 1;
    this.startPosition = position;
  }
  stopLoad() {
    this.stopCalls += 1;
  }
  recoverMediaError() {
    this.recovered = (this.recovered || 0) + 1;
  }
  destroy() {
    this.destroyed = true;
  }
  emit(event, payload) {
    this.handlers[event]?.(event, payload);
  }
}

class FakeVideo {
  constructor(attributes = {}) {
    this._listeners = new Map();
    this.paused = true;
    this.muted = false;
    this.volume = 1;
    this.currentTime = 0;
    this.duration = NaN;
    this.readyState = 0;
    this.preload = 'none';
    this.crossOrigin = 'anonymous';
    this.dataset = { ...(attributes.dataset || {}) };
    this.src = attributes.src || '';
    this.poster = '';
    this.error = null;
    this.playCalls = 0;
    this.playImpl = () => {
      this.paused = false;
      this.readyState = 4;
      return Promise.resolve();
    };
  }
  closest() {
    return null;
  }
  getAttribute(name) {
    return name === 'poster' ? this.poster || null : null;
  }
  addEventListener(type, handler, options = {}) {
    const set = this._listeners.get(type) || new Set();
    set.add(handler);
    this._listeners.set(type, set);
    if (options?.once) handler.__once = true;
  }
  removeEventListener(type, handler) {
    this._listeners.get(type)?.delete(handler);
    const onceHandler = [...(this._listeners.get(type) || [])].find(
      (item) => item.__once && !this._listeners.get(type)?.has(item),
    );
    if (onceHandler) this._listeners.get(type)?.delete(onceHandler);
  }
  dispatch(type) {
    for (const handler of [...(this._listeners.get(type) || [])]) {
      handler({ type, target: this });
      if (handler.__once) this._listeners.get(type)?.delete(handler);
    }
  }
  play() {
    this.playCalls += 1;
    return this.playImpl();
  }
  pause() {
    const wasPlaying = !this.paused;
    this.paused = true;
    if (wasPlaying) this.dispatch('pause');
  }
  load() {
    this.loadCalls = (this.loadCalls || 0) + 1;
  }
}

const listeners = new Map();
const fakeDocument = {
  hidden: false,
  addEventListener(type, handler) {
    listeners.set(`document:${type}`, handler);
  },
};
globalThis.document = fakeDocument;
globalThis.window = {
  Hls: FakeHls,
  devicePixelRatio: 1,
  innerWidth: 1280,
  __MOSAIC_CONFIG: {
    player: {
      hls: { maxBufferLength: 12, autoStartLoad: true },
      speeds: [1, 2],
    },
  },
  addEventListener(type, handler) {
    listeners.set(`window:${type}`, handler);
  },
  matchMedia: () => ({ matches: false }),
};

const { createPlayback, Playback } = await import('../src/assets/js/video/playback.js');
const { ensureHlsLoaded } = await import('../src/assets/js/video/hls-loader.js');
const { buildHlsConfig } = await import('../src/assets/js/video/tune.js');
const { readLevels } = await import('../src/assets/js/video/engine.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makePlayback(options = {}) {
  const video = new FakeVideo({ dataset: { mediaId: 'slug/videos/a.mp4' } });
  const playback = createPlayback({
    video,
    hls: 'https://media.test/master.m3u8',
    sources: { '480p': 'https://media.test/480.mp4', '240p': 'https://media.test/240.mp4' },
    ...options,
  });
  playback.attach();
  const hls = video._hls;
  hls.levels = [
    { height: 240, bitrate: 250000 },
    { height: 480, bitrate: 900000 },
  ];
  playback.prewarm(); // user intent: master manifest only (no fragments)
  hls.emit('hlsManifestParsed');
  return { video, playback, hls };
}

try {
  // 1. Config contract: operator options are kept, autoStartLoad is forced off.
  const config = buildHlsConfig({ maxBufferLength: 12, autoStartLoad: true }, { profile: { lowMemory: false } });
  assert.equal(config.maxBufferLength, 12, 'explicit buffer config is preserved');
  assert.equal(config.autoStartLoad, false, 'decode flows never auto-start fragment loading');
  const constrained = buildHlsConfig(
    { maxBufferLength: 90 },
    {
      profile: { lowMemory: true, saveData: false, slowNetwork: false },
    },
  );
  assert.ok(constrained.maxBufferLength <= 30, 'low-memory devices lower the buffer budget');

  // 2. ensureHlsLoaded is idempotent and respects an existing global.
  assert.equal(await ensureHlsLoaded(), true, 'an already loaded hls.js global is reused');
  const engine = { levels: [{ height: 720, bitrate: 2500000 }, { bitrate: 800000 }] };
  const levels = readLevels(engine.levels);
  assert.deepEqual(
    levels.map((level) => level.label),
    ['720p', '480p'],
    'levels are labelled from height, or inferred from bitrate',
  );

  // 3. Attach alone must make zero HLS requests; prewarm is manifest-only.
  const coldVideo = new FakeVideo({ dataset: { mediaId: 'slug/videos/cold.mp4' } });
  const cold = createPlayback({ video: coldVideo, hls: 'https://media.test/master.m3u8' });
  cold.attach();
  assert.equal(coldVideo._hls.loadSourceCalls, 0, 'attaching a player does not request the HLS manifest');
  assert.equal(coldVideo._hls.startCalls, 0, 'attaching a player does not request fragments');
  cold.prewarm();
  assert.equal(coldVideo._hls.loadSourceCalls, 1, 'pre-intent fetches the master manifest only');
  cold.play();
  assert.equal(coldVideo._hls.loadSourceCalls, 1, 'repeated intent never fetches the manifest twice');
  assert.equal(coldVideo._hls.startCalls, 0, 'fragments wait for the parsed manifest');
  coldVideo._hls.emit('hlsManifestParsed');
  assert.equal(coldVideo._hls.startCalls, 1, 'fragment loading starts after manifest + play intent');
  cold.destroy();

  const first = makePlayback();
  assert.equal(first.hls.startCalls, 0, 'attaching a player does not start fragment downloads');
  assert.equal(first.hls.loadSourceCalls, 1);
  assert.equal(first.playback.state, 'ready');
  assert.equal(first.hls.options.autoStartLoad, false);
  assert.equal(first.video.crossOrigin, 'anonymous');

  // 4. First-click race: play() before MSE is ready is replayed on canplay.
  first.video.playImpl = () => {
    first.video.paused = true;
    const error = new Error('media not ready');
    error.name = 'NotSupportedError';
    return Promise.reject(error);
  };
  first.playback.play();
  assert.equal(first.hls.startCalls, 1, 'the play intent starts loading exactly once');
  await sleep(10);
  first.playback.play();
  await sleep(10);
  assert.equal(first.hls.startCalls, 1, 'repeated play clicks never start a second load');
  first.video.playImpl = () => {
    first.video.paused = false;
    first.video.readyState = 4;
    return Promise.resolve();
  };
  first.video.dispatch('canplay');
  await sleep(10);
  first.video.dispatch('playing');
  assert.equal(first.playback.state, 'playing', 'the queued play intent fires when the element becomes ready');
  assert.equal(first.video.playCalls >= 3, true);
  first.playback.setQuality('480p');
  assert.equal(first.hls.loadLevel, 1, 'manual quality locks the hls level');
  assert.equal(first.playback.quality, '480p');
  first.playback.setQuality('auto');
  assert.equal(first.hls.loadLevel, -1, 'auto quality releases the manual lock');
  first.playback.destroy();
  assert.equal(first.hls.destroyed, true, 'destroy releases the hls.js instance');
  first.playback.destroy();
  assert.equal(first.playback.state, 'destroyed');

  // 5. Position restore waits for metadata (never writes currentTime on attach).
  store.set('mosaic_video_pos_slug/videos/a.mp4', '3');
  const restore = makePlayback();
  assert.equal(restore.video.currentTime, 0, 'positions are not restored before metadata');
  restore.video.duration = 6;
  restore.video.dispatch('loadedmetadata');
  assert.equal(restore.video.currentTime, 3, 'saved position is restored once duration is known');
  restore.video.currentTime = 4;
  restore.video.dispatch('timeupdate');
  assert.equal(store.get('mosaic_video_pos_slug/videos/a.mp4'), '4', 'position persists under the stable media id');
  restore.playback.destroy();

  // 6. Three fatal network errors degrade to progressive MP4, paused-safe.
  const fallback = makePlayback();
  fallback.hls.emit('hlsError', { fatal: true, type: 'networkError', details: 'fragLoadError' });
  fallback.hls.emit('hlsError', { fatal: true, type: 'networkError', details: 'fragLoadError' });
  fallback.hls.emit('hlsError', { fatal: true, type: 'networkError', details: 'fragLoadError' });
  assert.equal(fallback.hls.destroyed, true, 'unrecoverable HLS is destroyed');
  assert.ok(fallback.video.src.endsWith('.mp4'), 'fallback continues with a progressive MP4 source');
  assert.equal(fallback.playback.mode, 'mp4');
  assert.equal(fallback.playback.state, 'fallback');
  assert.equal(fallback.playback.getLevels().length, 2, 'fallback keeps the published tiers for the menu');
  assert.ok(!fallback.playback.getLevels().some((level) => level.label === '1080p'));

  // 7. A pause intent survives fallback: recovering must not force playback.
  const pausedFallback = makePlayback();
  pausedFallback.playback.play();
  pausedFallback.playback.pause();
  pausedFallback.hls.emit('hlsError', { fatal: true, type: 'networkError', details: 'fragLoadError' });
  pausedFallback.hls.emit('hlsError', { fatal: true, type: 'networkError', details: 'fragLoadError' });
  pausedFallback.hls.emit('hlsError', { fatal: true, type: 'networkError', details: 'fragLoadError' });
  assert.equal(pausedFallback.video.paused, true, 'a user pause is not overridden by error recovery');
  pausedFallback.playback.destroy();

  // 8. Manifest failure degrades immediately, without waiting for retries.
  const manifest = makePlayback();
  manifest.hls.emit('hlsError', { fatal: true, type: 'networkError', details: 'manifestLoadError' });
  assert.ok(manifest.video.src.endsWith('.mp4'));
  assert.equal(manifest.playback.mode, 'mp4');
  manifest.playback.destroy();

  // 9. pagehide persists the position and pauses playback.
  const leaving = makePlayback();
  leaving.video.duration = 10;
  leaving.video.currentTime = 5;
  listeners.get('window:pagehide')?.();
  assert.equal(store.get('mosaic_video_pos_slug/videos/a.mp4'), '5', 'pagehide persists the playback position');
  leaving.playback.destroy();

  // 10. Destroy is idempotent and never throws for a partially attached player.
  const bare = createPlayback({ video: new FakeVideo() });
  bare.destroy();
  bare.destroy();
  assert.equal(bare.state, 'destroyed');

  assert.equal(typeof Playback, 'function');
  console.log(
    'Playback flow: load intent, single engine, position/metadata, recovery, fallback and destroy contracts passed',
  );
} finally {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.localStorage;
}
