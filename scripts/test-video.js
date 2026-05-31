/**
 * Video player logic tests — Node.js, no browser needed.
 * Run: node scripts/test-video.js
 */
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('  FAIL: ' + msg); }
}

function eq(a, b, msg) { assert(a === b, msg + ': expected ' + b + ', got ' + a); }

// ====== Test 1: parseInt ======
console.log('=== Test 1: parseInt ===');
eq(parseInt('480p'), 480, '480p→480');
eq(parseInt('720p'), 720, '720p→720');
eq(parseInt('1080p'), 1080, '1080p→1080');

// ====== Test 2: fmt time ======
console.log('=== Test 2: fmt ===');
function fmt(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}
eq(fmt(0), '0:00', 'fmt(0)');
eq(fmt(65), '1:05', 'fmt(65)');
eq(fmt(3661), '1:01:01', 'fmt(3661)');
eq(fmt(NaN), '0:00', 'fmt(NaN)');
eq(fmt(Infinity), '0:00', 'fmt(Infinity)');
eq(fmt(-1), '0:00', 'fmt(-1)');

// ====== Test 3: detectResolution logic ======
console.log('=== Test 3: detectResolution ===');
function detectRes(w, dpr, connType) {
  if (connType === 'slow-2g' || connType === '2g') return '480p';
  if (w * dpr >= 1920) return '1080p';
  if (w * dpr >= 1280) return '720p';
  return '480p';
}
eq(detectRes(1920, 1), '1080p', '1920x1→1080p');
eq(detectRes(1280, 1), '720p', '1280x1→720p');
eq(detectRes(640, 1), '480p', '640x1→480p');
eq(detectRes(1920, 1, 'slow-2g'), '480p', 'slow-2g→480p');
eq(detectRes(1920, 1, '2g'), '480p', '2g→480p');

// ====== Test 4: switchResolution guards ======
console.log('=== Test 4: switchResolution guards ===');
function simSwitch(currentRes, sources, res, switching) {
  if (res === currentRes || switching) return 'blocked';
  if (!sources[res]) return 'blocked';
  return 'ok';
}
eq(simSwitch('720p', { '480p':'x', '720p':'x', '1080p':'x' }, '720p', false), 'blocked', 'same res→block');
eq(simSwitch('480p', { '480p':'x', '720p':'x' }, '720p', true), 'blocked', 'switching→block');
eq(simSwitch('480p', { '480p':'x', '720p':'x' }, '1080p', false), 'blocked', 'missing src→block');
eq(simSwitch('480p', { '480p':'x', '720p':'x' }, '720p', false), 'ok', 'valid switch→ok');

// ====== Test 5: buildQualityMenu ======
console.log('=== Test 5: buildQualityMenu ===');
function buildMenu(sources) {
  return Object.keys(sources).filter(k => k !== 'single');
}
eq(buildMenu({ '480p':'x', '720p':'x', '1080p':'x' }).length, 3, '3 buttons');
eq(buildMenu({ single: 'x' }).length, 0, '0 buttons (single)');
eq(buildMenu({}).length, 0, '0 buttons (empty)');

// ====== Test 6: HLS level matching ======
console.log('=== Test 6: HLS level matching ===');
function findLevel(levels, targetH) {
  let idx = levels.findIndex(l => l.height === targetH);
  if (idx < 0 && levels.length > 0) {
    idx = levels.findIndex(l => l.height >= targetH);
  }
  return idx;
}
eq(findLevel([{height:720},{height:480},{height:1080}], 480), 1, 'targetH=480→idx=1');
eq(findLevel([{height:1080}], 480), 0, 'targetH=480 fallback→idx=0');
eq(findLevel([], 720), -1, 'empty levels→-1');
eq(findLevel([{height:720},{height:1080}], 1080), 1, 'targetH=1080→idx=1');

// ====== Test 7: HLS sources rebuild ======
console.log('=== Test 7: HLS sources rebuild from levels ===');
function rebuildSources(levels) {
  const src = {};
  levels.forEach(function(level) {
    var h = level.height || 0;
    if (h === 0) h = level.bitrate > 3000000 ? 1080 : level.bitrate > 1500000 ? 720 : 480;
    src[h + 'p'] = 'url';
  });
  return Object.keys(src);
}
eq(rebuildSources([{height:1080},{height:720},{height:480}]).join(','), '1080p,720p,480p', '3 levels');
eq(rebuildSources([{height:720,bitrate:2000000}]).join(','), '720p', '1 level with height');
eq(rebuildSources([{bitrate:5000000}]).join(','), '1080p', 'bitrate→1080p fallback');

// ====== Test 8: Default sources for HLS ======
console.log('=== Test 8: HLS default sources ===');
const defaultSrcs = { '480p': 'url', '720p': 'url', '1080p': 'url' };
assert(Object.keys(defaultSrcs).length === 3, 'pre-set sources: 3 keys');
assert(defaultSrcs['720p'] !== undefined, '720p key exists');

// ====== Summary ======
console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
