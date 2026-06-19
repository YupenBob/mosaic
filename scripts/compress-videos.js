import fs from 'fs-extra';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { CONTENT_DIR, DIST_DIR, ensureDir, getMtime, log, warn } from './utils.js';

const ALL_RESOLUTIONS = [
  { name: '480p', height: 480 },
  { name: '720p', height: 720 },
  { name: '1080p', height: 1080 },
  { name: '4K', height: 2160 },
];

function getSourceHeight(srcPath) {
  try {
    const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=noprint_wrappers=1:nokey=1 "${srcPath}"`, { encoding: 'utf-8', timeout: 10000 });
    const h = parseInt(out.trim());
    return h > 0 ? h : 2160; // Default to 4K if detection fails
  } catch { return 2160; } // Default to 4K — safer to transcode than skip
}

const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'webm'];

function ffmpegAvailable() {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function findAllVideos() {
  const videos = [];
  const postDirs = await fs.readdir(CONTENT_DIR).catch(() => []);
  for (const dir of postDirs) {
    const postPath = path.join(CONTENT_DIR, dir);
    const stat = await fs.stat(postPath);
    if (!stat.isDirectory()) continue;
    const videosDir = path.join(postPath, 'videos');
    if (!(await fs.pathExists(videosDir))) continue;
    const files = await fs.readdir(videosDir);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase().slice(1);
      if (VIDEO_EXTS.includes(ext)) {
        videos.push({ dir, videosDir, file });
      }
    }
  }
  return videos;
}

function transcode(srcPath, outPath, height) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', srcPath,
      '-vf', `scale=-2:${height},fps=30`,
      '-c:v', 'libx264',
      '-crf', _vidQuality.crf || '23',
      '-preset', _vidQuality.preset || 'fast',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-max_muxing_queue_size', '1024',
      '-movflags', '+faststart',
      '-y',
      outPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTail = '';
    proc.stderr.on('data', (d) => {
      // Keep only last 500 chars to avoid OOM from massive ffmpeg logs
      errTail = (errTail + d.toString()).slice(-500);
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${errTail}`));
    });
    proc.on('error', reject);
  });
}

function generatePoster(srcPath, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', srcPath,
      '-ss', '00:00:01',
      '-vframes', '1',
      '-vf', 'scale=-2:720',
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

function hlsSegment(mp4Path, outputDir, baseName, resName) {
  return new Promise((resolve, reject) => {
    const playlistPath = path.join(outputDir, `${baseName}-${resName}.m3u8`);
    const segmentPattern = path.join(outputDir, `${baseName}-${resName}-%03d.ts`);
    const args = [
      '-i', mp4Path,
      '-c', 'copy',
      '-hls_time', '6',
      '-hls_list_size', '0',
      '-hls_segment_filename', segmentPattern,
      playlistPath,
      '-y',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTail = '';
    proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-500); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`HLS segment exit ${code}: ${errTail}`));
    });
    proc.on('error', reject);
  });
}

function generateMasterPlaylist(outputDir, baseName, resolutions, playlistPath) {
  if (!playlistPath) playlistPath = path.join(outputDir, `${baseName}-master.m3u8`);
  let content = '#EXTM3U\n#EXT-X-VERSION:3\n';
  const bwMap = { '480p': 800000, '720p': 2000000, '1080p': 5000000, '4K': 15000000 };
  const resMap = { '480p': '854x480', '720p': '1280x720', '1080p': '1920x1080', '4K': '3840x2160' };
  resolutions.forEach((res) => {
    content += `#EXT-X-STREAM-INF:BANDWIDTH=${bwMap[res]},RESOLUTION=${resMap[res]}\n`;
    content += `${baseName}-${res}.m3u8\n`;
  });
  fs.writeFileSync(playlistPath, content);
}

async function processVideo({ dir, videosDir, file }) {
  const rawBase = path.parse(file).name;
  // Sanitize: ASCII-safe baseName for FFmpeg output (strip non-ASCII, keep alnum + _-)
  const baseName = rawBase.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'video';
  const outputDir = path.join(DIST_DIR, 'posts', dir, 'media', 'videos');
  await ensureDir(outputDir);
  const srcPath = path.join(videosDir, file);
  const srcMtime = getMtime(srcPath);

  // Only transcode at or below source resolution
  const srcHeight = getSourceHeight(srcPath);
  const RESOLUTIONS = ALL_RESOLUTIONS.filter(r => !srcHeight || r.height <= srcHeight);
  if (RESOLUTIONS.length === 0) {
    warn(`Video ${file}: all resolutions above source, using source as-is`);
    const destPath = path.join(outputDir, file);
    if (getMtime(destPath) <= srcMtime) await fs.copy(srcPath, destPath);
    return;
  }

  // Try transcoding, fall back to copy on failure
  let anySuccess = false;
  const successRes = [];
  for (const res of RESOLUTIONS) {
    const outName = `${baseName}-${res.name}.mp4`;
    const outPath = path.join(outputDir, outName);
    const outMtime = getMtime(outPath);
    if (outMtime > srcMtime) { anySuccess = true; successRes.push(res.name); continue; }
    try {
      log(`Transcoding ${file} → ${res.name}...`);
      await transcode(srcPath, outPath, res.height);
      anySuccess = true;
      successRes.push(res.name);
    } catch (err) {
      warn(`Failed to transcode ${file} at ${res.name}: ${err.message}`);
      break;
    }
  }

  // HLS packaging — always run for each existing MP4 (separate from transcode)
  for (const res of RESOLUTIONS) {
    const outPath = path.join(outputDir, `${baseName}-${res.name}.mp4`);
    if (!fs.existsSync(outPath)) continue;
    const hlsPlaylistPath = path.join(outputDir, `${baseName}-${res.name}.m3u8`);
    if (getMtime(hlsPlaylistPath) <= getMtime(outPath)) {
      try {
        log(`HLS segment ${file} → ${res.name}...`);
        await hlsSegment(outPath, outputDir, baseName, res.name);
        successRes.push(res.name);
      } catch (err) { warn(`HLS segment failed for ${res.name}: ${err.message}`); }
    } else {
      successRes.push(res.name);
    }
  }

  // Generate per-video master HLS playlist (not shared between videos)
  const uniqueRes = [...new Set(successRes)];
  if (uniqueRes.length > 1) {
    const masterPath = path.join(outputDir, `${baseName}-master.m3u8`);
    if (getMtime(masterPath) <= srcMtime) {
      generateMasterPlaylist(outputDir, baseName, uniqueRes, masterPath);
    }
  }

  // Fallback
  if (!anySuccess) {
    const destPath = path.join(outputDir, file);
    if (getMtime(destPath) <= srcMtime) {
      await fs.copy(srcPath, destPath);
      log(`Copied ${file} as-is (transcode unavailable)`);
    }
  }

  // Generate poster
  const posterPath = path.join(outputDir, `${baseName}-poster.jpg`);
  if (getMtime(posterPath) <= srcMtime) {
    try {
      await generatePoster(srcPath, posterPath);
    } catch (err) {
      warn(`Failed to generate poster for ${file}: ${err.message}`);
    }
  }
}

let _vidQuality = { crf: '23', preset: 'fast' };

export async function compressVideos(vidQuality) {
  if (vidQuality) _vidQuality = { ..._vidQuality, ...vidQuality };
  if (!ffmpegAvailable()) {
    warn('FFmpeg not available, skipping video compression');
    return [];
  }
  const videos = await findAllVideos();
  if (videos.length === 0) {
    log('No videos found to compress');
    return [];
  }
  log(`Found ${videos.length} videos to process`);
  // Process videos sequentially to avoid overwhelming the system
  for (const video of videos) {
    await processVideo(video);
  }
  log('Video compression complete');
  return videos;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  compressVideos().catch(console.error);
}
