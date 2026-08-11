/**
 * Music metadata + cover extraction smoke test.
 *
 * Builds a 2s MP3 with an embedded 64x64 cover and title/artist/album tags via
 * ffmpeg, then runs scripts/music-meta.mjs extraction and asserts the values.
 *
 * Run: node tests/music-meta-smoke.mjs (wired into `npm run check`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractMusicMeta, extractMusicCover } from '../scripts/music-meta.mjs';

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-music-'));
const fixture = path.join(tmp, 'fixture.mp3');
const coverOut = path.join(tmp, 'cover.jpg');
try {
  const made = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x4361ee:s=64x64,format=rgb24',
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-c:v',
      'mjpeg',
      '-disposition:v',
      'attached_pic',
      '-metadata',
      'title=Test Title',
      '-metadata',
      'artist=Test Artist',
      '-metadata',
      'album=Test Album',
      '-t',
      '2',
      fixture,
    ],
    { stdio: 'ignore' },
  );
  check('ffmpeg fixture created', made.status === 0 && fs.existsSync(fixture) && fs.statSync(fixture).size > 1000);

  const meta = await extractMusicMeta(fixture);
  check('duration ~2s', meta.duration >= 1 && meta.duration <= 4, `got=${meta.duration}`);
  check('title read', meta.title === 'Test Title', `got=${JSON.stringify(meta.title)}`);
  check('artist read', meta.artist === 'Test Artist');
  check('album read', meta.album === 'Test Album');

  const hasCover = await extractMusicCover(fixture, coverOut);
  check('cover extracted', hasCover && fs.existsSync(coverOut) && fs.statSync(coverOut).size > 100);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nmusic-meta-smoke: ${failures === 0 ? 'OK' : failures + ' failure(s)'}`);
process.exit(failures === 0 ? 0 : 1);
