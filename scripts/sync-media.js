/**
 * Mosaic v0.8 — R2 Media Sync
 *
 * Handles bidirectional media syncing between the local content directory
 * and Cloudflare R2. Used by GitHub Actions during build.
 *
 * Usage:
 *   node scripts/sync-media.js pull    # R2 → local (before build)
 *   node scripts/sync-media.js push    # local → R2 (after processing)
 *   node scripts/sync-media.js status  # Show sync status
 */

import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { CONTENT_DIR, DIST_DIR, log, warn } from './utils.js';

const R2_BUCKET = process.env.R2_BUCKET || 'mosaic-media';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

/**
 * Run rclone command with R2 configuration.
 */
function rclone(args) {
  const cmd = `rclone ${args}`;
  try {
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 300000 });
    return out;
  } catch (err) {
    warn(`rclone error: ${err.message}`);
    return null;
  }
}

/**
 * Check if rclone is configured and accessible.
 */
function isR2Available() {
  try {
    execSync('rclone version', { stdio: 'ignore' });
    return !!(process.env.R2_ACCESS_KEY && process.env.R2_SECRET_KEY && process.env.R2_ENDPOINT);
  } catch {
    return false;
  }
}

/**
 * Pull original media from R2 to local content directory.
 * Only downloads photos/, videos/, music/ subdirectories.
 */
async function pullOriginals(slug) {
  if (!isR2Available()) {
    warn('R2 not configured, skipping pull');
    return;
  }

  const source = slug
    ? `r2:${R2_BUCKET}/originals/${slug}/`
    : `r2:${R2_BUCKET}/originals/`;

  let dest = path.join(CONTENT_DIR);
  if (slug) dest = path.join(dest, slug);

  await fs.ensureDir(dest);

  log(`Syncing R2 → local: ${source} → ${dest}`);
  const includes = '--include "photos/**" --include "videos/**" --include "music/**" --include "cover.*"';

  rclone(`copy "${source}" "${dest}" ${includes} --transfers 4 --verbose --ignore-existing`);
}

/**
 * Push processed media from local to R2.
 */
async function pushProcessed(slug) {
  if (!isR2Available()) {
    warn('R2 not configured, skipping push');
    return;
  }

  const postDirs = slug
    ? [path.join(CONTENT_DIR, slug)]
    : fs.readdirSync(CONTENT_DIR)
        .filter((d) => {
          try { return fs.statSync(path.join(CONTENT_DIR, d)).isDirectory(); } catch { return false; }
        })
        .map((d) => path.join(CONTENT_DIR, d));

  for (const postDir of postDirs) {
    const slugName = path.basename(postDir);

    // Push processed photos
    const photosDir = path.join(postDir, 'photos');
    if (fs.existsSync(photosDir)) {
      log(`Pushing photos: ${slugName}`);
      rclone(`copy "${photosDir}" "r2:${R2_BUCKET}/processed/${slugName}/photos/" --include "*-480p.webp" --include "*-720p.webp" --include "*-1080p.webp" --include "*-meta.json" --transfers 4 --ignore-existing`);
    }

    // Push processed videos
    const videosDir = path.join(postDir, 'videos');
    if (fs.existsSync(videosDir)) {
      log(`Pushing videos: ${slugName}`);
      rclone(`copy "${videosDir}" "r2:${R2_BUCKET}/processed/${slugName}/videos/" --include "*-480p.*" --include "*-720p.*" --include "*-1080p.*" --include "*-4K.*" --include "master.m3u8" --include "*-poster.jpg" --include "*.ts" --transfers 2 --ignore-existing`);
    }

    // Push processed music
    const musicDir = path.join(postDir, 'music');
    if (fs.existsSync(musicDir)) {
      log(`Pushing music: ${slugName}`);
      rclone(`copy "${musicDir}" "r2:${R2_BUCKET}/processed/${slugName}/music/" --include "*-320k.mp3" --include "*-128k.mp3" --include "*-cover.webp" --include "music-meta.json" --include "waveform.json" --transfers 4 --ignore-existing`);
    }

    // Push cover variants
    const mediaDir = path.join(DIST_DIR, 'posts', slugName, 'media');
    if (fs.existsSync(mediaDir)) {
      log(`Pushing covers: ${slugName}`);
      rclone(`copy "${mediaDir}" "r2:${R2_BUCKET}/processed/${slugName}/covers/" --include "cover-*p.webp" --include "cover-meta.json" --transfers 4 --ignore-existing`);
    }
  }
}

/**
 * Show sync status between local and R2.
 */
async function showStatus() {
  if (!isR2Available()) {
    log('R2 not configured');
    return;
  }

  log('=== R2 Sync Status ===');

  // Count R2 objects
  const r2Count = rclone(`size "r2:${R2_BUCKET}/" --json`);
  if (r2Count) {
    try {
      const info = JSON.parse(r2Count);
      log(`R2: ${info.count || 0} objects, ${((info.bytes || 0) / 1024 / 1024).toFixed(1)} MB`);
    } catch { log('R2: unable to parse size info'); }
  }

  // Count local media
  let localPhotos = 0, localVideos = 0, localMusic = 0, localSize = 0;
  function countDir(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach((f) => {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isDirectory()) countDir(fp);
      else {
        const ext = path.extname(f).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) localPhotos++;
        else if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) localVideos++;
        else if (['.mp3', '.flac', '.wav', '.m4a'].includes(ext)) localMusic++;
        localSize += fs.statSync(fp).size;
      }
    });
  }
  countDir(CONTENT_DIR);
  log(`Local: ${localPhotos}p ${localVideos}v ${localMusic}m, ${(localSize / 1024 / 1024).toFixed(1)} MB`);
}

// ── CLI ──────────────────────────────────────
const command = process.argv[2] || 'status';
const slug = process.argv[3] || null;

(async () => {
  switch (command) {
    case 'pull':
      await pullOriginals(slug);
      break;
    case 'push':
      await pushProcessed(slug);
      break;
    case 'status':
      await showStatus();
      break;
    default:
      log(`Unknown command: ${command}. Use: pull | push | status`);
  }
})().catch(console.error);
