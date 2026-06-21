/**
 * Upload processed media from dist/ to R2 processed/
 * Uses rclone (configured by pipeline step)
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const DIST = path.resolve(import.meta.dirname, '..', 'dist');

// Walk dist/posts/*/media/ and upload each directory
const postsDir = path.join(DIST, 'posts');
if (!fs.existsSync(postsDir)) { console.log('No dist/posts/'); process.exit(0); }

let total = 0;
for (const slug of fs.readdirSync(postsDir)) {
  const mediaDir = path.join(postsDir, slug, 'media');
  if (!fs.existsSync(mediaDir)) continue;

  // Upload photos
  const photosDir = path.join(mediaDir, 'photos');
  if (fs.existsSync(photosDir)) {
    try {
      execSync(`rclone copy "${photosDir}" "r2:mosaic-media/processed/${slug}/photos/" --transfers 4 --ignore-existing`, { stdio: 'pipe', timeout: 60000 });
      const count = fs.readdirSync(photosDir).length;
      console.log(`  ${slug}/photos: ${count} files`);
      total += count;
    } catch (e) { console.error(`  ${slug}/photos FAILED: ${e.message}`); }
  }

  // Upload videos
  const videosDir = path.join(mediaDir, 'videos');
  if (fs.existsSync(videosDir)) {
    try {
      execSync(`rclone copy "${videosDir}" "r2:mosaic-media/processed/${slug}/videos/" --transfers 2 --ignore-existing`, { stdio: 'pipe', timeout: 120000 });
      const count = fs.readdirSync(videosDir).length;
      console.log(`  ${slug}/videos: ${count} files`);
      total += count;
    } catch (e) { console.error(`  ${slug}/videos FAILED: ${e.message}`); }
  }

  // Upload covers
  const coverFiles = fs.readdirSync(mediaDir).filter(f => f.startsWith('cover-'));
  if (coverFiles.length) {
    const coversDir = path.join(DIST, 'posts', slug, 'media', 'covers');
    try {
      execSync(`rclone copy "${mediaDir}" "r2:mosaic-media/processed/${slug}/covers/" --include "cover-*" --transfers 4 --ignore-existing`, { stdio: 'pipe', timeout: 60000 });
      console.log(`  ${slug}/covers: ${coverFiles.length} files`);
      total += coverFiles.length;
    } catch (e) { console.error(`  ${slug}/covers FAILED: ${e.message}`); }
  }
}
console.log(`Upload complete: ${total} files`);
