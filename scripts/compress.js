/**
 * Compress all images + videos in content/posts/ → dist/posts/{slug}/media/
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content', 'posts');
const DIST = path.join(ROOT, 'dist');
const CHECKSUMS_FILE = path.join(ROOT, 'content', '.media-checksums.json');

// Load existing checksums
let checksums = {};
try { checksums = JSON.parse(fs.readFileSync(CHECKSUMS_FILE, 'utf-8')); } catch {}

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
    if (!changed(src)) { console.log(`  SKIP ${f} (unchanged)`); continue; }
    const img = sharp(src);
    const meta = await img.metadata();
    const aspect = meta.width / (meta.height || 1);

    // LQIP: 10px thumbnail for instant placeholder
    const thumbOut = path.join(outDir, `${base}-10p.webp`);
    if (!fs.existsSync(thumbOut)) await img.clone().resize({ width: THUMB_W, withoutEnlargement: true }).webp({ quality: 30 }).toFile(thumbOut);

    for (const w of SIZES) {
      const out = path.join(outDir, `${base}-${w}p.webp`);
      if (fs.existsSync(out)) continue;
      await img.clone().resize({ width: w, withoutEnlargement: true })
        .webp({ quality: QUALITY[w] || 80 }).toFile(out);
    }
    // Save meta
    fs.writeFileSync(path.join(outDir, `${base}-meta.json`), JSON.stringify({ aspect, width: meta.width, height: meta.height }));
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
  if (!changed(coverFile)) { console.log(`  SKIP cover (unchanged)`); return; }

  const outDir = path.join(DIST, 'posts', slug, 'media');
  fs.mkdirSync(outDir, { recursive: true });
  const img = sharp(coverFile);
  const meta = await img.metadata();
  const aspect = meta.width / (meta.height || 1);

  // LQIP
  const thumbOut = path.join(outDir, 'cover-10p.webp');
  if (!fs.existsSync(thumbOut)) await img.clone().resize({ width: THUMB_W, withoutEnlargement: true }).webp({ quality: 30 }).toFile(thumbOut);
  for (const w of SIZES) {
    const out = path.join(outDir, `cover-${w}p.webp`);
    if (fs.existsSync(out)) continue;
    await img.clone().resize({ width: w, withoutEnlargement: true })
      .webp({ quality: QUALITY[w] || 80 }).toFile(out);
  }
  fs.writeFileSync(path.join(outDir, 'cover-meta.json'), JSON.stringify({ aspect, width: meta.width, height: meta.height }));
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
];

async function compressVideo(file, postDir, slug) {
  const baseName = path.parse(file).name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'video';
  const srcPath = path.join(postDir, 'videos', file);
  const outDir = path.join(DIST, 'posts', slug, 'media', 'videos');
  fs.mkdirSync(outDir, { recursive: true });

  const srcHeight = getSourceHeight(srcPath);
  const resList = ALL_RES.filter(r => r.height <= srcHeight);
  if (resList.length === 0) {
    console.log(`  ${file}: source too small (${srcHeight}px), copying as-is`);
    fs.copyFileSync(srcPath, path.join(outDir, file));
    return;
  }

  const successRes = [];
  // Transcode to each resolution
  for (const res of resList) {
    const outPath = path.join(outDir, `${baseName}-${res.name}.mp4`);
    if (fs.existsSync(outPath)) { successRes.push(res.name); continue; }
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', [
          '-i', srcPath, '-vf', `scale=-2:${res.height},fps=30`,
          '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
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
    if (!fs.existsSync(posterPath)) {
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ['-i', srcPath, '-ss', '00:00:01', '-vframes', '1', '-vf', 'scale=-2:720', '-y', posterPath], { stdio: 'ignore' });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        proc.on('error', reject);
      });
    }
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
}

// ── Main ──
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
        if (!changed(src)) { console.log(`  SKIP ${f} (unchanged)`); continue; }
        await compressVideo(f, postDir, slug);
      }
    }
  }
}
// Save checksums for next build
fs.writeFileSync(CHECKSUMS_FILE, JSON.stringify(checksums, null, 2));
console.log(`Compression complete. Checksums saved (${Object.keys(checksums).length} entries)`);
