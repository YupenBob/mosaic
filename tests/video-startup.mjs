import assert from 'node:assert/strict';
import { normalizeConfig } from '../shared/config.mjs';
import { initHls } from '../src/assets/js/video/engine.js';
function start(config, preference = null) {
  globalThis.localStorage = { getItem: () => preference };
  globalThis.window = {
    __MOSAIC_CONFIG: config,
    Hls: class {
      constructor(options) {
        this.options = options;
        this.startLevel = options.startLevel;
        this.levels = [{ height: 240 }, { height: 360 }, { height: 480 }];
        this.events = {};
      }
      loadSource() {}
      attachMedia() {}
      on(event, fn) {
        this.events[event] = fn;
      }
    },
  };
  const player = { isHLS: true, video: {}, updateQualityActive() {} };
  initHls.call(player, { src: 'https://fixture.test/master.m3u8' }, () => {});
  player.hls.events.hlsManifestParsed();
  return player;
}
try {
  const config = normalizeConfig();
  const automatic = start(config);
  assert.equal(automatic.hls.startLevel, 0, 'automatic playback starts at the lowest published tier');
  assert.equal(automatic.hls.loadLevel, undefined, 'startup tier does not lock automatic adaptation');
  assert.equal(automatic.hls.options.autoStartLoad, false);
  assert.equal(start(normalizeConfig({ player: { hls: { startLevel: 1 } } })).hls.startLevel, 1);
  assert.equal(start(normalizeConfig({ player: { hls: { startLevel: -1 } } })).hls.startLevel, -1);
  const manualLow = start(config, '240p');
  assert.equal(manualLow.hls.loadLevel, 0, 'manual 240p preference is retained');
  assert.equal(manualLow.currentRes, '240p');
  assert.equal(start(config, '480p').hls.loadLevel, 2);
  const unavailable = start(config, '4K');
  assert.equal(unavailable.hls.loadLevel, undefined, 'unavailable preference keeps adaptation');
  assert.equal(unavailable.hls.startLevel, 0);
  console.log('Video startup: configurable initial tier, automatic adaptation and published manual preferences passed');
} finally {
  delete globalThis.window;
  delete globalThis.localStorage;
}
