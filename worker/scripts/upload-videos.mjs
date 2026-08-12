/**
 * Upload processed video media (m3u8/ts/mp4/poster) to R2 processed/{slug}/videos/
 * with Cache-Control: no-store and correct Content-Types.
 *
 * Why not rclone: rclone's metadata/header flags do not reliably set the
 * Cache-Control HTTP header on R2 objects, and its .ts mime detection is wrong.
 * This SDK-based uploader sets both deterministically at PUT time.
 *
 * Reconcile mode: compress.js now streams each finished tier to R2 while it
 * transcodes, so this step HEAD-checks every local file and only uploads the
 * missing ones (idempotent backstop for skipped/failed streaming uploads).
 *
 * Env: R2_ACCESS_KEY, R2_SECRET_KEY, CF_ACCOUNT_ID (or R2_ENDPOINT), R2_BUCKET.
 * Usage: node worker/scripts/upload-videos.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { canUpload, headObjectMeta, uploadFile, copyWithCacheControl, listVideoKeys } from './r2-upload.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'dist');

// Default no-store guarantees correct CORS on direct responses. Once a
// Cloudflare Transform Rule forces ACAO on the media host, set this env to
// "public, max-age=31536000" to restore edge caching (fast playback).
const cacheControl = process.env.VIDEO_CACHE_CONTROL || 'no-store';
if (!canUpload()) {
  console.error('R2 credentials not configured (R2_ACCESS_KEY/R2_SECRET_KEY/CF_ACCOUNT_ID or R2_ENDPOINT)');
  process.exit(1);
}

const postsDir = path.join(DIST, 'posts');
if (!fs.existsSync(postsDir)) {
  console.log('No dist/posts/');
  process.exit(0);
}

let total = 0;
for (const slug of fs.readdirSync(postsDir)) {
  const vdir = path.join(postsDir, slug, 'media', 'videos');
  if (!fs.existsSync(vdir)) continue;
  for (const f of fs.readdirSync(vdir)) {
    const filePath = path.join(vdir, f);
    const key = `processed/${slug}/videos/${f}`;
    try {
      const existing = await headObjectMeta(key);
      if (existing === null) {
        await uploadFile({ key, filePath, cacheControl });
        console.log(`  upload ${key}`);
        total++;
      }
    } catch (e) {
      console.error(`  FAIL ${key}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

// Refresh Cache-Control on ALL existing processed video objects (independent of
// local dist, so cache-hit builds still flip previously no-store objects).
let refreshed = 0;
for (const key of await listVideoKeys()) {
  try {
    const meta = await headObjectMeta(key);
    if (meta && meta.cacheControl !== cacheControl) {
      await copyWithCacheControl({ key, cacheControl, contentType: meta.contentType });
      console.log(`  cache ${key} (${meta.cacheControl || 'none'} -> ${cacheControl})`);
      refreshed++;
    }
  } catch (e) {
    console.error(`  REFRESH FAIL ${key}: ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(
  `Video reconcile complete: ${total} uploaded, ${refreshed} cache-control refreshed (Cache-Control: ${cacheControl})`,
);
if (process.exitCode) process.exit(1);
