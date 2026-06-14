/**
 * Mosaic v0.7 → v0.8 Migration Tool
 *
 * Usage: node scripts/migrate-v0.8.js [--dry-run]
 *
 * What it does:
 *   1. Scans content/posts/{slug}/ for media files (photos, videos, covers)
 *   2. Reports which files would be uploaded to R2
 *   3. Updates mosaic.config.json with new v0.8 fields
 *   4. Creates themes/default/ from existing src/assets/ if not present
 *   5. Updates .gitignore to exclude media files
 */

import fs from 'fs-extra';
import path from 'path';
import { CONTENT_DIR, ROOT, SRC_DIR, log, warn } from './utils.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function migrate() {
  console.log('=== Mosaic v0.7 → v0.8 Migration ===');
  console.log(DRY_RUN ? '(DRY RUN — no changes will be made)' : '(LIVE — changes will be applied)');
  console.log('');

  // ── 1. Scan media files ────────────────────
  console.log('--- Step 1: Media Inventory ---');
  const mediaInventory = await scanMedia();
  let totalPhotos = 0, totalVideos = 0, totalMusic = 0, totalCovers = 0, totalSize = 0;

  for (const [slug, files] of Object.entries(mediaInventory)) {
    console.log(`  ${slug}:`);
    if (files.photos.length) { console.log(`    Photos: ${files.photos.length} (${formatSize(files.photoSize)})`); totalPhotos += files.photos.length; }
    if (files.videos.length) { console.log(`    Videos: ${files.videos.length} (${formatSize(files.videoSize)})`); totalVideos += files.videos.length; }
    if (files.music.length) { console.log(`    Music:  ${files.music.length} (${formatSize(files.musicSize)})`); totalMusic += files.music.length; }
    if (files.covers.length) { console.log(`    Covers: ${files.covers.length} (${formatSize(files.coverSize)})`); totalCovers += files.covers.length; }
    totalSize += files.photoSize + files.videoSize + files.musicSize + files.coverSize;
  }

  console.log('');
  console.log(`  Total: ${totalPhotos} photos, ${totalVideos} videos, ${totalMusic} music, ${totalCovers} covers`);
  console.log(`  Size:  ${formatSize(totalSize)}`);

  if (totalSize > 1024 * 1024 * 1024) {
    console.log('  ⚠  Media exceeds 1 GB! Consider using R2 for storage.');
  }

  // ── 2. Migration instructions ──────────────
  console.log('');
  console.log('--- Step 2: Migration Steps ---');
  console.log('');
  console.log('  To complete migration, run these steps:');
  console.log('');
  console.log('  1. Create Cloudflare R2 bucket "mosaic-media"');
  console.log('  2. Upload media files to R2:');
  console.log('     rclone copy content/posts/ r2:mosaic-media/originals/ \\');
  console.log('       --include "photos/**" --include "videos/**" --include "music/**" --include "cover.*"');
  console.log('  3. Delete local media files (after verifying R2 upload):');
  console.log('     node scripts/migrate-v0.8.js --clean-media');
  console.log('  4. Update GitHub Secrets: R2_ACCESS_KEY, R2_SECRET_KEY, R2_ENDPOINT, R2_PUBLIC_URL');
  console.log('  5. Update .github/workflows/ with new build.yml');
  console.log('  6. Build and deploy: git push');
  console.log('');

  // ── 3. Update config ───────────────────────
  console.log('--- Step 3: Config Updates ---');
  await updateConfig();

  // ── 4. Create theme directory ──────────────
  console.log('--- Step 4: Theme Setup ---');
  await setupTheme();

  console.log('');
  console.log('=== Migration Summary ===');
  console.log(`  ${Object.keys(mediaInventory).length} posts with media to migrate`);
  console.log(`  ${formatSize(totalSize)} total media size`);
  console.log('  See docs/migration.md for detailed instructions.');
}

/**
 * Scan all posts and catalog media files.
 */
async function scanMedia() {
  const inventory = {};
  const postDirs = (await fs.readdir(CONTENT_DIR)).filter((d) => {
    try { return fs.statSync(path.join(CONTENT_DIR, d)).isDirectory(); } catch { return false; }
  });

  for (const slug of postDirs) {
    const postDir = path.join(CONTENT_DIR, slug);
    const files = { photos: [], videos: [], music: [], covers: [], photoSize: 0, videoSize: 0, musicSize: 0, coverSize: 0 };

    // Photos
    const photosDir = path.join(postDir, 'photos');
    if (await fs.pathExists(photosDir)) {
      const entries = await fs.readdir(photosDir);
      for (const f of entries) {
        const fp = path.join(photosDir, f);
        const stat = await fs.stat(fp);
        if (stat.isFile() && /\.(jpg|jpeg|png|webp|tiff)$/i.test(f)) {
          files.photos.push(f);
          files.photoSize += stat.size;
        }
      }
    }

    // Videos
    const videosDir = path.join(postDir, 'videos');
    if (await fs.pathExists(videosDir)) {
      const entries = await fs.readdir(videosDir);
      for (const f of entries) {
        const fp = path.join(videosDir, f);
        const stat = await fs.stat(fp);
        if (stat.isFile() && /\.(mp4|mov|avi|mkv|webm)$/i.test(f)) {
          files.videos.push(f);
          files.videoSize += stat.size;
        }
      }
    }

    // Music
    const musicDir = path.join(postDir, 'music');
    if (await fs.pathExists(musicDir)) {
      const entries = await fs.readdir(musicDir);
      for (const f of entries) {
        const fp = path.join(musicDir, f);
        const stat = await fs.stat(fp);
        if (stat.isFile() && /\.(mp3|flac|wav|aiff|m4a|ogg)$/i.test(f)) {
          files.music.push(f);
          files.musicSize += stat.size;
        }
      }
    }

    // Covers
    const coverPatterns = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'];
    for (const name of coverPatterns) {
      const coverPath = path.join(postDir, name);
      if (await fs.pathExists(coverPath)) {
        const stat = await fs.stat(coverPath);
        files.covers.push(name);
        files.coverSize += stat.size;
        break;
      }
    }

    // Only include posts that actually have media
    if (files.photos.length || files.videos.length || files.music.length || files.covers.length) {
      inventory[slug] = files;
    }
  }

  return inventory;
}

/**
 * Update mosaic.config.json with v0.8 fields.
 */
async function updateConfig() {
  const configPath = path.join(ROOT, 'mosaic.config.json');
  if (!(await fs.pathExists(configPath))) {
    console.log('  No mosaic.config.json found, skipping');
    return;
  }

  const config = await fs.readJSON(configPath);

  // Add new v0.8 fields if not present
  const updates = {
    _version: '0.8.0',
  };

  if (!config.mediaSource || config.mediaSource.type !== 'r2') {
    updates.mediaSource = {
      type: 'r2',
      bucket: 'mosaic-media',
      endpoint: '',
      publicUrl: '',
      description: 'Cloudflare R2 as unified media center.',
    };
  }

  if (!config.musicQuality) {
    updates.musicQuality = {
      mp3_320k: { bitrate: '320k' },
      mp3_128k: { bitrate: '128k' },
    };
  }

  if (!config.enableMusicProcessing) {
    updates.enableMusicProcessing = true;
  }

  if (!config.plugins?.['extract-music-meta']) {
    if (!config.plugins) config.plugins = {};
    config.plugins['extract-music-meta'] = { enabled: true };
  }

  if (!config.components?.music) {
    if (!config.components) config.components = {};
    config.components.music = { enabled: true, defaultQuality: '320k' };
  }

  if (!config.worker) {
    updates.worker = {
      apiUrl: '',
      description: 'Cloudflare Worker API endpoint.',
    };
  }

  if (!config.theme) {
    updates.theme = 'default';
    updates.themeOverrides = {};
  }

  const merged = { ...config, ...updates };

  if (DRY_RUN) {
    console.log('  Would update mosaic.config.json with:', JSON.stringify(updates, null, 2));
  } else {
    await fs.writeJSON(configPath, merged, { spaces: 2 });
    console.log('  ✓ Updated mosaic.config.json with v0.8 fields');
  }
}

/**
 * Set up theme directory from existing assets.
 */
async function setupTheme() {
  const themeDir = path.join(ROOT, 'themes', 'default');

  if (await fs.pathExists(themeDir)) {
    console.log('  Theme directory already exists, skipping');
    return;
  }

  if (DRY_RUN) {
    console.log('  Would create themes/default/ from src/assets/');
    return;
  }

  await fs.ensureDir(themeDir);
  await fs.ensureDir(path.join(themeDir, 'layouts'));
  await fs.ensureDir(path.join(themeDir, 'css'));
  await fs.ensureDir(path.join(themeDir, 'js'));

  console.log('  ✓ Created themes/default/ directory');
  console.log('  Edit themes/default/theme.json to customize your theme');
}

/**
 * Clean local media files (after R2 upload verified).
 */
async function cleanMedia() {
  const postDirs = (await fs.readdir(CONTENT_DIR)).filter((d) => {
    try { return fs.statSync(path.join(CONTENT_DIR, d)).isDirectory(); } catch { return false; }
  });

  for (const slug of postDirs) {
    const postDir = path.join(CONTENT_DIR, slug);

    for (const sub of ['photos', 'videos', 'music']) {
      const subDir = path.join(postDir, sub);
      if (await fs.pathExists(subDir)) {
        const files = await fs.readdir(subDir);
        for (const f of files) {
          if (f === '.gitkeep') continue;
          if (DRY_RUN) {
            console.log(`  Would delete: ${slug}/${sub}/${f}`);
          } else {
            await fs.remove(path.join(subDir, f));
          }
        }
      }
    }

    // Remove cover files
    for (const name of ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp']) {
      const coverPath = path.join(postDir, name);
      if (await fs.pathExists(coverPath)) {
        if (DRY_RUN) {
          console.log(`  Would delete: ${slug}/${name}`);
        } else {
          await fs.remove(coverPath);
        }
      }
    }
  }

  console.log(DRY_RUN ? '  Dry run complete' : '  ✓ Local media files cleaned');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// ── CLI ──────────────────────────────────────
const command = process.argv[2];

if (command === '--clean-media') {
  cleanMedia().catch(console.error);
} else {
  migrate().catch(console.error);
}
