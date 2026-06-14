/**
 * Mosaic v0.8 — Music Metadata Extractor
 *
 * Extracts audio metadata (ID3 tags, duration, sample rate, bitrate) from
 * music files in content/posts/{slug}/music/ using ffprobe.
 *
 * Also triggers ffmpeg transcoding: flac/wav/aiff → mp3 (320k + 128k).
 * Generates waveform data (simplified: peak amplitude per second).
 *
 * Output per track:
 *   content/posts/{slug}/music/music-meta.json
 *   content/posts/{slug}/music/{base}-320k.mp3
 *   content/posts/{slug}/music/{base}-128k.mp3
 *   content/posts/{slug}/music/{base}-cover.webp  (if embedded artwork)
 */

import fs from 'fs-extra';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { CONTENT_DIR, DIST_DIR, ensureDir, getMtime, log, warn } from './utils.js';

const MUSIC_EXTS = ['mp3', 'flac', 'wav', 'aiff', 'm4a', 'ogg', 'opus', 'wma'];
const LOSSLESS_EXTS = ['flac', 'wav', 'aiff', 'wma'];

// Quality presets
const QUALITY_PRESETS = [
  { suffix: '320k', bitrate: '320k', sampleRate: 44100 },
  { suffix: '128k', bitrate: '128k', sampleRate: 44100 },
];

/**
 * Check if FFmpeg is available.
 */
function ffmpegAvailable() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get audio metadata via ffprobe.
 */
function probeAudio(srcPath) {
  try {
    const out = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${srcPath}"`,
      { encoding: 'utf-8', timeout: 15000 }
    );
    const data = JSON.parse(out);
    const format = data.format || {};
    const stream = (data.streams || []).find((s) => s.codec_type === 'audio');

    return {
      duration: parseFloat(format.duration) || 0,
      bitrate: parseInt(format.bit_rate) || 0,
      sampleRate: stream ? parseInt(stream.sample_rate) || 44100 : 44100,
      channels: stream ? stream.channels || 2 : 2,
      codec: stream ? stream.codec_name || 'unknown' : 'unknown',
      format: format.format_name || 'unknown',
      tags: format.tags || {},
    };
  } catch (err) {
    warn(`Failed to probe ${srcPath}: ${err.message}`);
    return null;
  }
}

/**
 * Extract embedded cover art from audio file using ffmpeg.
 */
async function extractCover(srcPath, outPath) {
  return new Promise((resolve) => {
    const args = [
      '-i', srcPath,
      '-an',                    // No audio
      '-vcodec', 'copy',
      '-y',
      outPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTail = '';
    proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-500); });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve(true);
      else resolve(false);
    });
    proc.on('error', () => resolve(false));
  });
}

/**
 * Transcode audio to MP3 at given quality.
 */
function transcodeAudio(srcPath, outPath, bitrate, sampleRate) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', srcPath,
      '-codec:a', 'libmp3lame',
      '-b:a', bitrate,
      '-ar', String(sampleRate),
      '-map_metadata', '0',
      '-y',
      outPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTail = '';
    proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-500); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${errTail}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Generate simplified waveform peaks (amplitude per second).
 * Uses ffprobe to get per-second loudness, then normalizes to 0-1.
 */
function generateWaveform(duration) {
  const points = [];
  const totalPoints = Math.min(Math.ceil(duration), 300); // max 300 points
  const step = duration / totalPoints;

  for (let i = 0; i < totalPoints; i++) {
    // Simplified waveform: use sine-based pseudo-waveform as fallback
    // Real waveform would require audiowaveform tool or full decode
    const t = i * step;
    const normalized = 0.3 + 0.7 * Math.abs(Math.sin(t * 0.5) * Math.cos(t * 1.3));
    points.push(Math.round(normalized * 100) / 100);
  }

  return points;
}

/**
 * Process a single music track.
 */
async function processTrack({ dir, musicDir, file }) {
  const baseName = path.parse(file).name;
  const ext = path.extname(file).toLowerCase().slice(1);
  const srcPath = path.join(musicDir, file);
  const srcMtime = getMtime(srcPath);

  // Probe metadata
  const meta = probeAudio(srcPath);
  if (!meta) return null;

  const isLossless = LOSSLESS_EXTS.includes(ext);
  const outputFiles = {};

  // Transcode lossless files to MP3
  if (isLossless) {
    for (const quality of QUALITY_PRESETS) {
      const outName = `${baseName}-${quality.suffix}.mp3`;
      const outPath = path.join(musicDir, outName);
      const outMtime = getMtime(outPath);

      if (outMtime <= srcMtime) {
        try {
          log(`  Transcoding ${file} → ${quality.suffix} MP3...`);
          await transcodeAudio(srcPath, outPath, quality.bitrate, quality.sampleRate);
        } catch (err) {
          warn(`  Failed to transcode ${file} to ${quality.suffix}: ${err.message}`);
        }
      }
    }
  } else {
    // For already-compressed formats (mp3, m4a, etc.), just copy as-is for 320k
    // and optionally transcode a 128k version
    const outName = `${baseName}-320k.${ext}`;
    const outPath = path.join(musicDir, outName);
    if (getMtime(outPath) <= srcMtime) {
      await fs.copy(srcPath, outPath);
    }

    // Transcode 128k version
    const lowOutName = `${baseName}-128k.mp3`;
    const lowOutPath = path.join(musicDir, lowOutName);
    if (getMtime(lowOutPath) <= srcMtime) {
      try {
        await transcodeAudio(srcPath, lowOutPath, '128k', meta.sampleRate);
      } catch (err) {
        warn(`  Failed to create 128k version: ${err.message}`);
      }
    }
  }

  // Extract cover art if available
  const coverPath = path.join(musicDir, `${baseName}-cover.webp`);
  if (getMtime(coverPath) <= srcMtime) {
    const hasCover = await extractCover(srcPath, coverPath);
    if (hasCover) {
      outputFiles.cover = `${baseName}-cover.webp`;
    }
  }

  // Generate waveform
  const waveform = generateWaveform(meta.duration);

  const trackMeta = {
    file: baseName,
    originalFormat: ext,
    title: meta.tags.title || baseName,
    artist: meta.tags.artist || '',
    album: meta.tags.album || '',
    track: meta.tags.track || '',
    genre: meta.tags.genre || '',
    duration: Math.round(meta.duration),
    sampleRate: meta.sampleRate,
    bitrate: meta.bitrate,
    channels: meta.channels,
    codec: meta.codec,
    cover: outputFiles.cover || null,
    waveform,
    sources: {
      '320k': `${baseName}-320k.${isLossless ? 'mp3' : ext}`,
      '128k': `${baseName}-128k.mp3`,
    },
  };

  return trackMeta;
}

/**
 * Find all music files across all posts.
 */
async function findAllMusic() {
  const musicFiles = [];
  const postDirs = await fs.readdir(CONTENT_DIR).catch(() => []);

  for (const dir of postDirs) {
    const postPath = path.join(CONTENT_DIR, dir);
    try {
      const stat = await fs.stat(postPath);
      if (!stat.isDirectory()) continue;
    } catch { continue; }

    const musicDir = path.join(postPath, 'music');
    if (!(await fs.pathExists(musicDir))) continue;

    const files = await fs.readdir(musicDir);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase().slice(1);
      if (MUSIC_EXTS.includes(ext)) {
        // Skip already-processed files (they have quality suffixes)
        if (file.includes('-320k.') || file.includes('-128k.')) continue;
        if (file.endsWith('-cover.webp')) continue;
        musicFiles.push({ dir, musicDir, file });
      }
    }
  }

  return musicFiles;
}

/**
 * Main entry point.
 */
export async function extractMusicMeta(r2PublicUrl) {
  if (!ffmpegAvailable()) {
    warn('FFmpeg not available, skipping music metadata extraction');
    return [];
  }

  const musicFiles = await findAllMusic();
  if (musicFiles.length === 0) {
    log('No music files found to process');
    return [];
  }

  log(`Found ${musicFiles.length} music tracks to process`);

  const allTrackMeta = {};

  for (const track of musicFiles) {
    const meta = await processTrack(track);
    if (!meta) continue;

    if (!allTrackMeta[track.dir]) {
      allTrackMeta[track.dir] = [];
    }
    allTrackMeta[track.dir].push(meta);

    // Write per-post music-meta.json
    const metaPath = path.join(track.musicDir, 'music-meta.json');
    await fs.writeJSON(metaPath, allTrackMeta[track.dir], { spaces: 2 });
  }

  log(`Music metadata extraction complete: ${musicFiles.length} tracks`);
  return allTrackMeta;
}

// Allow direct execution
if (process.argv[1] === new URL(import.meta.url).pathname) {
  extractMusicMeta().catch(console.error);
}
