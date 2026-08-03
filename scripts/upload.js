/**
 * Upload processed media from dist/ to R2 processed/
 * Uses rclone (configured by pipeline step).
 * Default size+mtime comparison: unchanged files are skipped, changed files
 * overwrite (re-uploads propagate). Avoids --checksum, whose S3 checksum
 * headers Cloudflare R2 rejects with HTTP 501.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

function runUpload(label, cmd) {
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 300000 });
    console.log(`  ${label}: OK`);
  } catch (e) {
    console.error(`  ${label} FAILED: ${e.message}`);
    throw e;
  }
}

// Walk dist/posts/*/media/ and upload each directory
const postsDir = path.join(DIST, 'posts');
if (!fs.existsSync(postsDir)) { console.log('No dist/posts/'); process.exit(0); }

let total = 0;
try {
  for (const slug of fs.readdirSync(postsDir)) {
    const mediaDir = path.join(postsDir, slug, 'media');
    if (!fs.existsSync(mediaDir)) continue;

    // Upload photos
    const photosDir = path.join(mediaDir, 'photos');
    if (fs.existsSync(photosDir)) {
      runUpload(`${slug}/photos`, `rclone copy "${photosDir}" "r2:mosaic-media/processed/${slug}/photos/" --transfers 4 --retries 3`);
      total += fs.readdirSync(photosDir).length;
    }

    // Upload videos
    const videosDir = path.join(mediaDir, 'videos');
    if (fs.existsSync(videosDir)) {
      runUpload(`${slug}/videos`, `rclone copy "${videosDir}" "r2:mosaic-media/processed/${slug}/videos/" --transfers 4 --retries 3`);
      total += fs.readdirSync(videosDir).length;
    }

    // Upload covers
    const coverFiles = fs.readdirSync(mediaDir).filter(f => f.startsWith('cover-'));
    if (coverFiles.length) {
      runUpload(`${slug}/covers`, `rclone copy "${mediaDir}" "r2:mosaic-media/processed/${slug}/covers/" --include "cover-*" --transfers 4 --retries 3`);
      total += coverFiles.length;
    }

    // Upload music
    const musicDir = path.join(mediaDir, 'music');
    if (fs.existsSync(musicDir)) {
      runUpload(`${slug}/music`, `rclone copy "${musicDir}" "r2:mosaic-media/processed/${slug}/music/" --transfers 4 --retries 3`);
      total += fs.readdirSync(musicDir).length;
    }
  }

  // Build data (posts.json etc.) -> site-data/ so the Worker can serve the
  // post list from R2 (one GET) instead of N+1 GitHub contents calls.
  const dataDir = path.join(DIST, 'data');
  if (fs.existsSync(dataDir)) {
    runUpload('site-data', `rclone copy "${dataDir}" "r2:mosaic-media/site-data/" --transfers 4 --retries 3`);
    total += fs.readdirSync(dataDir).length;
  }
  console.log(`Upload complete: ${total} files`);
} catch (e) {
  console.error(`Upload failed: ${e.message}`);
  process.exit(1);
}
