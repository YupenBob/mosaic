/**
 * Compress all images + videos in content/posts/ → dist/posts/{slug}/media/
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync, execFile, execFileSync, spawn } from 'child_process';
import sharp from 'sharp';
import { videoBase } from './media-names.mjs';
import { ALL_RES, tierListFor, uploadAfterN, budgetExceeded, manifestComplete } from './media-utils.mjs';
import { canUpload, uploadFile, headObject } from '../worker/scripts/r2-upload.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content', 'posts');
const DIST = path.join(ROOT, 'dist');
// Checksums live under dist/ so CI can cache them (override via CHECKSUMS_FILE env)
const CHECKSUMS_FILE = process.env.CHECKSUMS_FILE || path.join(DIST, '.media-checksums.json');

// Video settings from config (tunable in Admin -> Config):
//   videoQuality.preset    – ffmpeg x264 preset (faster = quicker, larger)
//   videoQuality.maxHeight       – highest transcode tier (1080 default; 4K opt-in)
//   videoQuality.uploadAfterTiers – streaming-upload batch size (1 = per tier)
//   build.timeoutMinutes        – job timeout; budget guard = 85% of it (env wins)
let VIDEO_PRESET = 'fast';
let VIDEO_MAX_HEIGHT = 1080;
let UPLOAD_AFTER_TIERS = 1;
let TIMEOUT_MINUTES = 90;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'mosaic.config.json'), 'utf-8'));
  VIDEO_PRESET = cfg.videoQuality?.preset || 'fast';
  VIDEO_MAX_HEIGHT = cfg.videoQuality?.maxHeight || 1080;
  UPLOAD_AFTER_TIERS = Number(cfg.videoQuality?.uploadAfterTiers) || 1;
  TIMEOUT_MINUTES = Number(cfg.build?.timeoutMinutes) || 90;
} catch {}
TIMEOUT_MINUTES = Number(process.env.TIMEOUT_MINUTES) || TIMEOUT_MINUTES;
const VIDEO_CACHE_CONTROL = process.env.VIDEO_CACHE_CONTROL || 'no-store';
// Budget clock: prefer the job start recorded by the pipeline, fall back to
// this process's start time (local runs / tests).
const PROCESS_START = Date.now();
const BUILD_STARTED_AT = Number(process.env.BUILD_STARTED_AT) || PROCESS_START;

// In CI (R2_CHECKSUMS_SYNC=1), pull the R2-persisted checksums over the
// cache-restored file: cancelled runs leave per-tier progress that the Actions
// cache never saved. Local builds keep the local file as the source of truth.
if (process.env.R2_CHECKSUMS_SYNC === '1' && process.env.R2_ACCESS_KEY && process.env.R2_BUCKET) {
  try {
    execFileSync(
      'rclone',
      [
        'copyto',
        `r2:${process.env.R2_BUCKET}/site-data/media-checksums.json`,
        CHECKSUMS_FILE,
        '--low-level-retries',
        '1',
      ],
      { timeout: 30000, stdio: 'ignore' },
    );
    console.log('R2 checksums restored (resume point from last run)');
  } catch {
    console.log('No R2 checksums to restore (fresh or local-only)');
  }
}

// Load existing checksums
let checksums = {};
try {
  checksums = JSON.parse(fs.readFileSync(CHECKSUMS_FILE, 'utf-8'));
} catch {}
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
  execFile(
    'rclone',
    ['copyto', PROGRESS_FILE, `r2:${process.env.R2_BUCKET}/site-data/build-progress.json`, '--low-level-retries', '1'],
    { timeout: 15000 },
    () => {
      _uploading = false;
    },
  );
}

// ── Checksums persistence (per-tier resume) ─────────────────
// Writes dist/.media-checksums.json and mirrors it to R2
// (site-data/media-checksums.json) so a cancelled build resumes from the last
// completed tier instead of re-transcoding the whole video next time.
let _lastChecksumsUpload = 0;
function persistChecksums(force = false) {
  checksums.__version__ = CHECKSUMS_VERSION;
  try {
    fs.writeFileSync(CHECKSUMS_FILE, JSON.stringify(checksums, null, 2));
  } catch {}
  if (!process.env.R2_ACCESS_KEY || !process.env.R2_BUCKET) return;
  if (!force && Date.now() - _lastChecksumsUpload < 10000) return;
  _lastChecksumsUpload = Date.now();
  execFile(
    'rclone',
    [
      'copyto',
      CHECKSUMS_FILE,
      `r2:${process.env.R2_BUCKET}/site-data/media-checksums.json`,
      '--low-level-retries',
      '1',
    ],
    { timeout: 15000 },
    () => {},
  );
}

// Store the video manifest in ALL_RES (descending) order and flush to disk/R2
// immediately so per-tier progress survives a timeout.
function persistVideoManifest(manifestKey, tierSet, srcHeight) {
  const tiers = ALL_RES.filter((r) => tierSet.has(r.name)).map((r) => r.name);
  checksums[manifestKey] = JSON.stringify({ tiers, height: srcHeight });
  persistChecksums(true);
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

process.on('exit', () => {
  try {
    writeProgress();
  } catch {}
});

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

const POSTS = fs.readdirSync(CONTENT).filter((d) => fs.statSync(path.join(CONTENT, d)).isDirectory());

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
    if (!forceReprocess && !changed(src)) {
      console.log(`  SKIP ${f} (unchanged)`);
      tick(`${slug}/${f}`);
      continue;
    }
    reportCurrent(`${slug}/${f}`);
    // Source changed: remove stale outputs so they are regenerated (and re-uploaded)
    for (const out of [
      `${base}-10p.webp`,
      `${base}-480p.webp`,
      `${base}-720p.webp`,
      `${base}-1080p.webp`,
      `${base}-meta.json`,
    ]) {
      fs.rmSync(path.join(outDir, out), { force: true });
    }
    const img = sharp(src);
    const meta = await img.metadata();
    const aspect = meta.width / (meta.height || 1);

    // LQIP: 10px thumbnail for instant placeholder
    await img
      .clone()
      .resize({ width: THUMB_W, withoutEnlargement: true })
      .webp({ quality: 30 })
      .toFile(path.join(outDir, `${base}-10p.webp`));

    for (const w of SIZES) {
      await img
        .clone()
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: QUALITY[w] || 80 })
        .toFile(path.join(outDir, `${base}-${w}p.webp`));
    }
    // Save meta
    fs.writeFileSync(
      path.join(outDir, `${base}-meta.json`),
      JSON.stringify({ aspect, width: meta.width, height: meta.height }),
    );
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
    if (fs.existsSync(p)) {
      coverFile = p;
      break;
    }
  }
  if (!coverFile) {
    // Try first photo as cover
    const photosDir = path.join(postDir, 'photos');
    if (fs.existsSync(photosDir)) {
      const files = fs
        .readdirSync(photosDir)
        .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort();
      if (files.length) coverFile = path.join(photosDir, files[0]);
    }
  }
  if (!coverFile) return;
  // Use a dedicated key so a first-photo cover isn't double-marked by compressPhotos
  const coverKey = `__cover__/${slug}`;
  const coverHash = md5(coverFile);
  const outDir = path.join(DIST, 'posts', slug, 'media');
  fs.mkdirSync(outDir, { recursive: true });
  if (!forceReprocess && checksums[coverKey] === coverHash) {
    console.log(`  SKIP cover (unchanged)`);
    return;
  }
  checksums[coverKey] = coverHash;
  for (const out of ['cover-10p.webp', 'cover-480p.webp', 'cover-720p.webp', 'cover-1080p.webp', 'cover-meta.json']) {
    fs.rmSync(path.join(outDir, out), { force: true });
  }
  const img = sharp(coverFile);
  const meta = await img.metadata();
  const aspect = meta.width / (meta.height || 1);

  // LQIP
  await img
    .clone()
    .resize({ width: THUMB_W, withoutEnlargement: true })
    .webp({ quality: 30 })
    .toFile(path.join(outDir, 'cover-10p.webp'));
  for (const w of SIZES) {
    await img
      .clone()
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: QUALITY[w] || 80 })
      .toFile(path.join(outDir, `cover-${w}p.webp`));
  }
  fs.writeFileSync(
    path.join(outDir, 'cover-meta.json'),
    JSON.stringify({ aspect, width: meta.width, height: meta.height }),
  );
  checksums[`__cover-meta__/${slug}`] = String(aspect);
}

// ── Video compression ──
function getSourceHeight(srcPath) {
  try {
    const out = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=noprint_wrappers=1:nokey=1 "${srcPath}"`,
      { encoding: 'utf-8', timeout: 10000 },
    );
    const h = parseInt(out.trim());
    return h > 0 ? h : 2160;
  } catch {
    return 2160;
  }
}

function budgetExceededNow() {
  return budgetExceeded(Date.now() - BUILD_STARTED_AT, TIMEOUT_MINUTES);
}

async function compressVideo(file, postDir, slug, seen) {
  const baseName = videoBase(file, seen);
  const srcPath = path.join(postDir, 'videos', file);
  const outDir = path.join(DIST, 'posts', slug, 'media', 'videos');
  fs.mkdirSync(outDir, { recursive: true });
  const manifestKey = `__video__/${slug}/${baseName}`;
  let manifest = null;
  try {
    manifest = checksums[manifestKey] ? JSON.parse(checksums[manifestKey]) : null;
  } catch {}

  const srcHeight = getSourceHeight(srcPath);
  const expectedTiers = tierListFor(srcHeight, VIDEO_MAX_HEIGHT);
  const srcChanged = forceReprocess || changed(srcPath);

  // Fast path: source unchanged and every expected tier is already in the
  // manifest (R2 holds the objects from the run that produced this manifest).
  if (!srcChanged && manifestComplete(manifest, expectedTiers)) {
    console.log(`  SKIP ${file} (unchanged)`);
    return;
  }

  // Source too small: keep the raw file as-is (no tiers).
  if (expectedTiers.length === 0) {
    console.log(`  ${file}: source too small (${srcHeight}px), copying as-is`);
    fs.copyFileSync(srcPath, path.join(outDir, file));
    persistVideoManifest(manifestKey, new Set(), srcHeight);
    return;
  }

  // Resume set: tiers already completed for this exact source. Only on a full
  // re-process (source changed / version bump) are stale outputs dropped.
  const resumeSet = new Set();
  if (!srcChanged && manifest) {
    for (const t of manifest.tiers || []) {
      if (expectedTiers.includes(t)) resumeSet.add(t);
    }
    if (canUpload() && resumeSet.size) {
      // Self-heal: a tier listed in the manifest may be missing in R2 (streaming
      // upload failed non-fatally and the run was cancelled before reconcile).
      for (const t of [...resumeSet]) {
        try {
          const size = await headObject(`processed/${slug}/videos/${baseName}-${t}.m3u8`);
          if (size === null) {
            console.log(`  ${file}: tier ${t} missing in R2, re-transcoding`);
            resumeSet.delete(t);
          }
        } catch (e) {
          console.warn(`  ${file}: HEAD ${t} failed (${e.message}), trusting manifest`);
        }
      }
    }
  } else {
    for (const stale of fs.readdirSync(outDir)) {
      if (stale === baseName + '-poster.jpg' || stale.startsWith(baseName + '-')) {
        fs.rmSync(path.join(outDir, stale), { force: true });
      }
    }
  }

  const successRes = new Set(resumeSet);
  const todo = expectedTiers.filter((t) => !resumeSet.has(t));
  const pendingUpload = [];
  let newDone = 0;

  const queueTierFiles = (resName) => {
    const prefix = `${baseName}-${resName}`;
    for (const f of fs.readdirSync(outDir)) {
      if (f === prefix + '.mp4' || f === prefix + '.m3u8' || (f.startsWith(prefix + '-') && f.endsWith('.ts'))) {
        pendingUpload.push(f);
      }
    }
  };

  const flushBatch = async () => {
    if (!pendingUpload.length || !canUpload()) return;
    const batch = pendingUpload.splice(0);
    for (const f of batch) {
      try {
        await uploadFile({
          key: `processed/${slug}/videos/${f}`,
          filePath: path.join(outDir, f),
          cacheControl: VIDEO_CACHE_CONTROL,
        });
        console.log(`  upload ${f}`);
      } catch (e) {
        console.warn(`  upload FAIL ${f}: ${e.message} (final reconcile will retry)`);
      }
    }
  };

  // Process tiers ascending (240p -> 4K): a budget cutoff then leaves the
  // cheap playable tiers done and defers only the expensive ones.
  for (const resName of todo) {
    if (budgetExceededNow()) {
      const remaining = todo.slice(todo.indexOf(resName)).join(', ');
      console.warn(`  ${file}: time budget exceeded, skipping remaining tiers: ${remaining}`);
      reportCurrent(`${slug}/videos/${file} — 跳过 ${resName}（时间预算）`);
      break;
    }
    const res = ALL_RES.find((r) => r.name === resName);
    // Re-transcoded tier: drop any stale files from a previous partial run
    // (segment counts differ) so only fresh segments get queued/uploaded.
    const tierPrefix = `${baseName}-${res.name}`;
    for (const stale of fs.readdirSync(outDir)) {
      if (stale === tierPrefix + '.mp4' || stale === tierPrefix + '.m3u8' || stale.startsWith(tierPrefix + '-')) {
        fs.rmSync(path.join(outDir, stale), { force: true });
      }
    }
    const outPath = path.join(outDir, `${baseName}-${res.name}.mp4`);
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(
          'ffmpeg',
          [
            '-i',
            srcPath,
            '-vf',
            `scale=-2:${res.height},fps=30`,
            '-c:v',
            'libx264',
            '-crf',
            '23',
            '-preset',
            VIDEO_PRESET,
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
            '-y',
            outPath,
          ],
          { stdio: 'ignore' },
        );
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        proc.on('error', reject);
      });
      console.log(`  ${file} → ${res.name}`);
    } catch (e) {
      console.error(`  FAIL ${res.name}: ${e.message}`);
      continue;
    }
    // HLS segment for this tier
    const plPath = path.join(outDir, `${baseName}-${res.name}.m3u8`);
    const segPattern = path.join(outDir, `${baseName}-${res.name}-%03d.ts`);
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(
          'ffmpeg',
          [
            '-i',
            outPath,
            '-c',
            'copy',
            '-hls_time',
            '6',
            '-hls_list_size',
            '0',
            '-hls_segment_filename',
            segPattern,
            plPath,
            '-y',
          ],
          { stdio: 'ignore' },
        );
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        proc.on('error', reject);
      });
    } catch (e) {
      console.error(`  HLS FAIL ${res.name}: ${e.message}`);
      continue;
    }
    successRes.add(res.name);
    newDone++;
    // Persist the per-tier manifest immediately (crash/timeout resume).
    persistVideoManifest(manifestKey, successRes, srcHeight);
    // Streaming upload: batch by uploadAfterTiers, flushing on every multiple
    // and on the last new tier (final partial batch).
    queueTierFiles(res.name);
    if (uploadAfterN(newDone, todo.length, UPLOAD_AFTER_TIERS)) await flushBatch();
  }

  // Generate poster
  try {
    const posterPath = path.join(outDir, `${baseName}-poster.jpg`);
    await new Promise((resolve, reject) => {
      const proc = spawn(
        'ffmpeg',
        ['-i', srcPath, '-ss', '00:00:01', '-vframes', '1', '-vf', 'scale=-2:720', '-y', posterPath],
        { stdio: 'ignore' },
      );
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      proc.on('error', reject);
    });
  } catch {}

  // Generate master playlist (uploaded after all tier files so a partial set
  // never advertises tiers that are not in R2 yet).
  if (successRes.size) {
    let master = '#EXTM3U\n#EXT-X-VERSION:3\n';
    for (const r of ALL_RES) {
      if (!successRes.has(r.name)) continue;
      master += `#EXT-X-STREAM-INF:BANDWIDTH=${r.bw},RESOLUTION=${r.label}\n`;
      master += `${baseName}-${r.name}.m3u8\n`;
    }
    fs.writeFileSync(path.join(outDir, `${baseName}-master.m3u8`), master);
  }

  await flushBatch();
  if (canUpload()) {
    const finalFiles = [`${baseName}-poster.jpg`];
    if (fs.existsSync(path.join(outDir, `${baseName}-master.m3u8`))) finalFiles.push(`${baseName}-master.m3u8`);
    for (const f of finalFiles) {
      try {
        await uploadFile({
          key: `processed/${slug}/videos/${f}`,
          filePath: path.join(outDir, f),
          cacheControl: VIDEO_CACHE_CONTROL,
        });
        console.log(`  upload ${f}`);
      } catch (e) {
        console.warn(`  upload FAIL ${f}: ${e.message} (final reconcile will retry)`);
      }
    }
  }
  persistVideoManifest(manifestKey, successRes, srcHeight);
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
    if (!forceReprocess && !changed(src)) {
      console.log(`  SKIP music ${f} (unchanged)`);
      tick(`${slug}/${f}`);
      continue;
    }
    reportCurrent(`${slug}/${f}`);
    // Source changed: remove stale outputs for this track
    for (const stale of fs.readdirSync(outDir)) {
      if (stale.startsWith(base + '-')) fs.rmSync(path.join(outDir, stale), { force: true });
    }
    for (const [label, bitrate] of [
      ['128k', '128k'],
      ['320k', '320k'],
    ]) {
      const outPath = path.join(outDir, `${base}-${label}.mp3`);
      try {
        await new Promise((resolve, reject) => {
          const proc = spawn('ffmpeg', ['-i', src, '-vn', '-c:a', 'libmp3lame', '-b:a', bitrate, '-y', outPath], {
            stdio: 'ignore',
          });
          proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
          proc.on('error', reject);
        });
        console.log(`  ${f} -> ${label}`);
      } catch (e) {
        console.error(`  MUSIC FAIL ${f} ${label}: ${e.message}`);
      }
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
    progress.total += fs.readdirSync(photosDir).filter((f) => /\.(jpg|jpeg|png|webp|tiff)$/i.test(f)).length;
  }
  const videosDir = path.join(postDir, 'videos');
  if (fs.existsSync(videosDir)) {
    progress.total += fs.readdirSync(videosDir).filter((f) => /\.(mp4|mov|avi|mkv|webm)$/i.test(f)).length;
  }
  const musicDir = path.join(postDir, 'music');
  if (fs.existsSync(musicDir)) {
    progress.total += fs.readdirSync(musicDir).filter((f) => /\.(mp3|flac|wav|ogg|m4a|aac)$/i.test(f)).length;
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
    const seenVideos = new Set();
    for (const f of fs.readdirSync(videosDir).sort()) {
      if (!/\.(mp4|mov|avi|mkv|webm)$/i.test(f)) continue;
      reportCurrent(`${slug}/videos/${f}`);
      await compressVideo(f, postDir, slug, seenVideos);
      tick(`${slug}/videos/${f}`);
    }
  }
  await compressMusic(postDir, slug);
}
// Save checksums for next build
persistChecksums(true);
_progressState = { stage: 'media-done', current: '全部媒体处理完成', done: progress.done, total: progress.total };
writeProgress();
console.log(`Compression complete. Checksums saved (${Object.keys(checksums).length} entries)`);
