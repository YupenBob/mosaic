/**
 * Waveform pipeline smoke: pure peak computation + ffmpeg decode integration.
 *
 * Run: node tests/waveform-smoke.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { computeWaveformPeaks } from '../scripts/media-utils.mjs';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`);
  if (!ok) failures++;
};

// ── 1. Pure computation ──
check(
  'silence -> all zeros',
  computeWaveformPeaks(new Int16Array(8000), 400).every((v) => v === 0),
);

const constPeaks = computeWaveformPeaks(new Int16Array(8000).fill(16000), 400);
check(
  'constant amplitude -> ~0.488',
  constPeaks.every((v) => Math.abs(v - 16000 / 32768) < 0.001),
  `first=${constPeaks[0]}`,
);

const shortPeaks = computeWaveformPeaks(new Int16Array(10).fill(32767), 4);
check(
  'short buffer -> 4 peaks at max',
  shortPeaks.length === 4 && shortPeaks.every((v) => Math.abs(v - 32767 / 32768) < 0.001),
);
check(
  'empty input -> zeros',
  computeWaveformPeaks(new Int16Array(0), 8).every((v) => v === 0),
);

// ── 2. ffmpeg integration (skip if ffmpeg is not installed) ──
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
if (hasFfmpeg) {
  const pcm = spawnSync(
    'ffmpeg',
    ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(pcm.status, 0, 'ffmpeg sine decode failed');
  const samples = new Int16Array(pcm.stdout.buffer, pcm.stdout.byteOffset, Math.floor(pcm.stdout.byteLength / 2));
  const peaks = computeWaveformPeaks(samples, 400);
  check('ffmpeg sine -> 400 peaks', peaks.length === 400);
  check(
    'ffmpeg sine -> non-zero amplitude present',
    peaks.some((v) => v > 0.01),
  );
  check(
    'ffmpeg sine -> all in [0,1]',
    peaks.every((v) => v >= 0 && v <= 1),
  );
} else {
  console.log('  SKIP ffmpeg integration (ffmpeg not found)');
}

console.log(`\nwaveform-smoke: ${failures === 0 ? 'OK' : failures + ' failures'}`);
process.exit(failures === 0 ? 0 : 1);
