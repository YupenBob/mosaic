/**
 * Music metadata + cover-art extraction for the media pipeline.
 *
 * Uses ffprobe (duration / title / artist / album tags) and ffmpeg (embedded
 * album art -> JPEG). Covers MP3/FLAC/M4A/OGG sources; sources without tags or
 * embedded art simply yield empty values and generate.js falls back to the
 * file name / site author.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => {
      out += d;
    });
    proc.stderr.on('data', (d) => {
      err += d;
    });
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err.slice(-300)}`)),
    );
  });
}

/**
 * Read duration (seconds, rounded) and title/artist/album tags from a track.
 * Never throws: missing tools / unreadable files yield empty metadata.
 *
 * @param {string} src - path to the source audio file
 * @returns {Promise<{duration:number,title:string,artist:string,album:string}>}
 */
export async function extractMusicMeta(src) {
  const meta = { duration: 0, title: '', artist: '', album: '' };
  try {
    const out = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:format_tags=title,artist,album',
      '-of',
      'json',
      src,
    ]);
    const j = JSON.parse(out);
    const fmt = j.format || {};
    const duration = parseFloat(fmt.duration);
    if (Number.isFinite(duration) && duration > 0) meta.duration = Math.round(duration);
    const tags = fmt.tags || {};
    meta.title = String(tags.title || '').trim();
    meta.artist = String(tags.artist || '').trim();
    meta.album = String(tags.album || '').trim();
  } catch {}
  return meta;
}

/**
 * Extract the embedded album art to a JPEG file. Re-encodes to MJPEG so the
 * output is always a valid `.jpg` regardless of the source picture codec.
 *
 * @param {string} src - path to the source audio file
 * @param {string} outPath - destination path (should end in .jpg)
 * @returns {Promise<boolean>} true when a cover was written and is non-empty
 */
export async function extractMusicCover(src, outPath) {
  for (const args of [
    ['-i', src, '-an', '-map', '0:v:0', '-c:v', 'mjpeg', '-q:v', '2', '-y', outPath],
    ['-i', src, '-an', '-c:v', 'mjpeg', '-q:v', '2', '-y', outPath],
  ]) {
    try {
      await run('ffmpeg', args);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return true;
    } catch {}
  }
  return false;
}
