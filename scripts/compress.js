/**
 * Compress all images + videos in content/posts/ → dist/posts/{slug}/media/
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync, execFile, spawn } from 'child_process';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content', 'posts');
const DIST = path.join(ROOT, 'dist');
// Checksums live under dist/ so CI can cache them (override via CHECKSUMS_FILE env)
const CHECKSUMS_FILE = process.env.CHECKSUMS_FILE || path.join(DIST, '.media-checksums.json');

// Video settings from config (tunable in Admin -> Config):
//   videoQuality.preset    – ffmpeg x264 preset (faster = quicker, larger)
//   videoQuality.maxHeight – highest transcode tier (1080 default; 4K opt-in)
let VIDEO_PRESET = 'fast';
let VIDEO_MAX_HEIGHT = 1080;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'mosaic.config.json'), 'utf-8'));
  VIDEO_PRESET = cfg.videoQuality?.preset || 'fast';
  VIDEO_MAX_HEIGHT = cfg.videoQuality?.maxHeight || 1080;
} catch {}

// Load existing checksums
let checksums = {};
try { checksums = JSON.parse(fs.readFileSync(CHECKSUMS_FILE, 'utf-8')); } catch {}
// v2 checksums add a media manifest (per-video tiers, cover aspect) so
// generate.js can emit HLS/multi-res URLs even on cache-hit (skip) builds.
const CHECKSUMS_VERSION = '2';
const forceReprocess = checksums.__version__ !== CHECKSUMS_VERSION;

// ── Build progress reporting ────────────────────────────────
// Writes dist/build-progress.json which the pipeline's background reporter
// uploads to R2 every few seconds, so the admin can show which media file is
// currently being processed ("具体转到哪里了").
const PROGRESS_FILE = path.join(DIST, 'build-progress.json');
const progress = { total: 0, done: 0 };
let _progressState = { stage: 'media', current: '准备中', done: 0, total: 0, updatedAt: new Date().toISOString() };
let _lastWrite = 0;

function writeProgress() {
  _progressState.updatedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(_progressState));
    uploadProgress();
  } catch {}
}

let _lastUpload = 0;
let _uploading = false;
// Upload progress straight from this process (a background loop started from a
// separate workflow step gets killed by the Actions runner, so we upload here).
function uploadProgress() {
  if (!process.env.R2_ACCESS_KEY || !process.env.R2_BUCKET || _uploading) return;
  if (Date.now() - _lastUpload < 5000) return;
  _lastUpload = Date.now();
  _uploading = true;
  execFile('rclone', ['copyto', PROGRESS_FILE, `r2:${process.env.R2_BUCKET}/site-data/build-progress.json`, '--low-level-retries', '1'], { timeout: 15000 }, () => {
    _uploading = false;
  });
}

function tick(current) {
  progress.done++;
  _progressState = { ..._progressState, current, done: progress.done, total: progress.total };
  // Throttle writes to ~every 2s; flush the latest state on exit.
  if (Date.now() - _lastWrite > 2000) {
    _lastWrite = Date.now();
    writeProgress();
  }
}

// Report the file being processed BEFORE it starts (long transcodes would
// otherwise show "准备中" for minutes).
function reportCurrent(current) {
  _progressState = { ..._progressState, current };
  if (Date.now() - _lastWrite > 2000) {
    _lastWrite = Date.now();
    writeProgress();
  }
}

process.on('exit', () => { try { writeProgress(); } catch {} });

function md5(filePath) {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

function changed(filePath) {
  const key = path.relative(CONTENT, filePath).replace(/\\/g, '/');
  const hash = md5(filePath);
  if (checksums[key] === hash) return false; // unchanged
  checksums[key] = hash;
  return true;
}

const POSTS = fs.readdirSync(CONTENT).filter(d => fs.statSync(path.join(CONTENT, d)).isDirectory());

// ── Image compression ──
const QUALITY = { 1080: 85, 720: 80, 480: 75 };
const SIZES = [1080, 720, 480];
const THUMB_W = 150; // LQIP placeholder — 150px wide, ~2KB

async function compressPhotos(postDir, slug) {
  const photosDir = path.join(postDir, 'photos');
  if (!fs.existsSync(photosDir)) return;

  const outDir = path.join(DIST, 'posts', slug, 'media', 'photos');
  fs.mkdirSync(outDir, { recursive: true });

  for (const f of fs.readdirSync(photosDir)) {
    if (!/\.(jpg|jpeg|png|webp|tiff)$/i.test(f)) continue;
    const base = path.parse(f).name;
    const src = path.join(photosDir, f);
    if (!forceReprocess && !changed(src)) { console.log(`  SKIP ${f} (unchanged)`); tick(`${slug}/${f}`); continue; }
    reportCurrent(`${slug}/${f}`);
    // Source changed: remove stale outputs so they are regenerated (and re-uploaded)
    for (const out of [`${base}-10p.webp`, `${base}-480p.webp`, `${base}-720p.webp`, `${base}-1080p.webp`, `${base}-meta.json`]) {
      fs.rmSync(path.join(outDir, out), { force: true });
    }
    const img = sharp(src);
    const meta = await img.metadata();
    const aspect = meta.width / (meta.height || 1);

    // LQIP: 10px thumbnail for instant placeholder
    await img.clone().resize({ width: THUMB_W, withoutEnlargement: true }).webp({ quality: 30 }).toFile(path.join(outDir, `${base}-10p.webp`));

    for (const w of SIZES) {
      await img.clone().resize({ width: w, withoutEnlargement: true })
        .webp({ quality: QUALITY[w] || 80 }).toFile(path.join(outDir, `${base}-${w}p.webp`));
    }
    // Save meta
    fs.writeFileSync(path.join(outDir, `${base}-meta.json`), JSON.stringify({ aspect, width: meta.width, height: meta.height }));
    checksums[`__photo-meta__/${slug}/${base}`] = String(aspect);
    tick(`${slug}/${f}`);
  }
}

// ── Cover compression ──
async function compressCover(postDir, slug) {
  // Find cover image
  const covers = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'];
  let coverFile = null;
  for (const c of covers) {
    const p = path.join(postDir, c);
    if (fs.existsSync(p)) { coverFile = p; break; }
  }
  if (!coverFile) {
    // Try first photo as cover
    const photosDir = path.join(postDir, 'photos');
    if (fs.existsSync(photosDir)) {
      const files = fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)).sort();
      if (files.length) coverFile = path.join(photosDir, files[0]);
    }
  }
  if (!coverFile) return;
  // Use a dedicated key so a first-photo cover isn't double-marked by compressPhotos
  const coverKey = `__cover__/${slug}`;
  const coverHash = md5(coverFile);
  const outDir = path.join(DIST, 'posts', slug, 'media');
  fs.mkdirSync(outDir, { recursive: true });
  if (!forceReprocess && checksums[coverKey] === coverHash) { console.log(`  SKIP cover (unchanged)`); return; }
  checksums[coverKey] = coverHash;
  for (const out of ['cover-10p.webp', 'cover-480p.webp', 'cover-720p.webp', 'cover-1080p.webp', 'cover-meta.json']) {
    fs.rmSync(path.join(outDir, out), { force: true });
  }
  const img = sharp(coverFile);
  const meta = await img.metadata();
  const aspect = meta.width / (meta.height || 1);

  // LQIP
  await img.clone().resize({ width: THUMB_W, withoutEnlargement: true }).webp({ quality: 30 }).toFile(path.join(outDir, 'cover-10p.webp'));
  for (const w of SIZES) {
    await img.clone().resize({ width: w, withoutEnlargement: true })
      .webp({ quality: QUALITY[w] || 80 }).toFile(path.join(outDir, `cover-${w}p.webp`));
  }
  fs.writeFileSync(path.join(outDir, 'cover-meta.json'), JSON.stringify({ aspect, width: meta.width, height: meta.height }));
  checksums[`__cover-meta__/${slug}`] = String(aspect);
}

// ── Video compression ──
function getSourceHeight(srcPath) {
  try {
    const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=noprint_wrappers=1:nokey=1 "${srcPath}"`, { encoding: 'utf-8', timeout: 10000 });
    const h = parseInt(out.trim());
    return h > 0 ? h : 2160;
  } catch { return 2160; }
}

const ALL_RES = [
  { name: '4K', height: 2160, bw: 15000000, label: '3840x2160' },
  { name: '1080p', height: 1080, bw: 5000000, label: '1920x1080' },
  { name: '720p', height: 720, bw: 2000000, label: '1280x720' },
  { name: '480p', height: 480, bw: 800000, label: '854x480' },
  { name: '360p', height: 360, bw: 400000, label: '640x360' },
  { name: '240p', height: 240, bw: 250000, label: '426x240' },
];

async function compressVideo(file, postDir, slug) {
  const baseName = path.parse(file).name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'video';
  const srcPath = path.join(postDir, 'videos', file);
  const outDir = path.join(DIST, 'posts', slug, 'media', 'videos');
  fs.mkdirSync(outDir, { recursive: true });
  // Source changed: remove stale outputs for this video before regenerating
  for (const stale of fs.readdirSync(outDir)) {
    if (stale === baseName + '-poster.jpg' || stale.startsWith(baseName + '-')) {
      fs.rmSync(path.join(outDir, stale), { force: true });
    }
  }

  const srcHeight = getSourceHeight(srcPath);
  const resList = ALL_RES.filter(r => r.height <= srcHeight && r.height <= VIDEO_MAX_HEIGHT);
  if (resList.length === 0) {
    console.log(`  ${file}: source too small (${srcHeight}px), copying as-is`);
    fs.copyFileSync(srcPath, path.join(outDir, file));
    checksums[`__video__/${slug}/${baseName}`] = JSON.stringify({ tiers: [], height: srcHeight });
    return;
  }

  const successRes = [];
  // Transcode to each resolution
  for (const res of resList) {
    const outPath = path.join(outDir, `${baseName}-${res.name}.mp4`);
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', [
          '-i', srcPath, '-vf', `scale=-2:${res.height},fps=30`,
          '-c:v', 'libx264', '-crf', '23', '-preset', VIDEO_PRESET,
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', outPath
        ], { stdio: 'ignore' });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        proc.on('error', reject);
      });
      successRes.push(res.name);
      console.log(`  ${file} → ${res.name}`);
    } catch (e) { console.error(`  FAIL ${res.name}: ${e.message}`); }
  }

  // HLS segment for each existing MP4
  for (const res of resList) {
    const mp4Path = path.join(outDir, `${baseName}-${res.name}.mp4`);
    if (!fs.existsSync(mp4Path)) continue;
    try {
      const plPath = path.join(outDir, `${baseName}-${res.name}.m3u8`);
      const segPattern = path.join(outDir, `${baseName}-${res.name}-%03d.ts`);
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', [
          '-i', mp4Path, '-c', 'copy', '-hls_time', '6', '-hls_list_size', '0',
          '-hls_segment_filename', segPattern, plPath, '-y'
        ], { stdio: 'ignore' });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        proc.on('error', reject);
      });
      if (!successRes.includes(res.name)) successRes.push(res.name);
    } catch (e) { console.error(`  HLS FAIL ${res.name}: ${e.message}`); }
  }

  // Generate poster
  try {
    const posterPath = path.join(outDir, `${baseName}-poster.jpg`);
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-i', srcPath, '-ss', '00:00:01', '-vframes', '1', '-vf', 'scale=-2:720', '-y', posterPath], { stdio: 'ignore' });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
      proc.on('error', reject);
    });
  } catch {}

  // Generate master playlist
  if (successRes.length) {
    let master = '#EXTM3U\n#EXT-X-VERSION:3\n';
    for (const r of ALL_RES) {
      if (!successRes.includes(r.name)) continue;
      master += `#EXT-X-STREAM-INF:BANDWIDTH=${r.bw},RESOLUTION=${r.label}\n`;
      master += `${baseName}-${r.name}.m3u8\n`;
    }
    fs.writeFileSync(path.join(outDir, `${baseName}-master.m3u8`), master);
  }
  checksums[`__video__/${slug}/${baseName}`] = JSON.stringify({ tiers: successRes, height: srcHeight });
}

// ── Music compression: 128k/320k MP3 ──
async function compressMusic(postDir, slug) {
  const musicDir = path.join(postDir, 'music');
  if (!fs.existsSync(musicDir)) return;
  const outDir = path.join(DIST, 'posts', slug, 'media', 'music');
  fs.mkdirSync(outDir, { recursive: true });

  for (const f of fs.readdirSync(musicDir)) {
    if (!/\.(mp3|flac|wav|ogg|m4a|aac)$/i.test(f)) continue;
    const base = path.parse(f).name;
    const src = path.join(musicDir, f);
    if (!forceReprocess && !changed(src)) { console.log(`  SKIP music ${f} (unchanged)`); tick(`${slug}/${f}`); continue; }
    reportCurrent(`${slug}/${f}`);
    // Source changed: remove stale outputs for this track
    for (const stale of fs.readdirSync(outDir)) {
      if (stale.startsWith(base + '-')) fs.rmSync(path.join(outDir, stale), { force: true });
    }
    for (const [label, bitrate] of [['128k', '128k'], ['320k', '320k']]) {
      const outPath = path.join(outDir, `${base}-${label}.mp3`);
      try {
        await new Promise((resolve, reject) => {
          const proc = spawn('ffmpeg', ['-i', src, '-vn', '-c:a', 'libmp3lame', '-b:a', bitrate, '-y', outPath], { stdio: 'ignore' });
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
          proc.on('error', reject);
        });
        console.log(`  ${f} -> ${label}`);
      } catch (e) { console.error(`  MUSIC FAIL ${f} ${label}: ${e.message}`); }
    }
    tick(`${slug}/${f}`);
  }
}

// ── Main ──
// Count media files first so the progress bar has a total
for (const slug of POSTS) {
  const postDir = path.join(CONTENT, slug);
  const photosDir = path.join(postDir, 'photos');
  if (fs.existsSync(photosDir)) {
    progress.total += fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png|webp|tiff)$/i.test(f)).length;
  }
  const videosDir = path.join(postDir, 'videos');
  if (fs.existsSync(videosDir)) {
    progress.total += fs.readdirSync(videosDir).filter(f => /\.(mp4|mov|avi|mkv|webm)$/i.test(f)).length;
  }
  const musicDir = path.join(postDir, 'music');
  if (fs.existsSync(musicDir)) {
    progress.total += fs.readdirSync(musicDir).filter(f => /\.(mp3|flac|wav|ogg|m4a|aac)$/i.test(f)).length;
  }
}
_progressState = { stage: 'media', current: '准备中', done: 0, total: progress.total };
writeProgress();

console.log(`Processing ${POSTS.length} posts...`);
for (const slug of POSTS) {
  const postDir = path.join(CONTENT, slug);
  console.log(`  ${slug}`);
  await compressPhotos(postDir, slug);
  await compressCover(postDir, slug);
  const videosDir = path.join(postDir, 'videos');
  if (fs.existsSync(videosDir)) {
    for (const f of fs.readdirSync(videosDir)) {
      if (/\.(mp4|mov|avi|mkv|webm)$/i.test(f)) {
        const src = path.join(videosDir, f);
        if (!forceReprocess && !changed(src)) { console.log(`  SKIP ${f} (unchanged)`); tick(`${slug}/videos/${f}`); continue; }
        reportCurrent(`${slug}/videos/${f}`);
        await compressVideo(f, postDir, slug);
        tick(`${slug}/videos/${f}`);
      }
    }
  }
  await compressMusic(postDir, slug);
}
// Save checksums for next build
checksums.__version__ = CHECKSUMS_VERSION;
fs.writeFileSync(CHECKSUMS_FILE, JSON.stringify(checksums, null, 2));
_progressState = { stage: 'media-done', current: '全部媒体处理完成', done: progress.done, total: progress.total };
writeProgress();
console.log(`Compression complete. Checksums saved (${Object.keys(checksums).length} entries)`);
