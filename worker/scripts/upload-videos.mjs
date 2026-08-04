/**
 * Upload processed video media (m3u8/ts/mp4/poster) to R2 processed/{slug}/videos/
 * with Cache-Control: no-store and correct Content-Types.
 *
 * Why not rclone: rclone's metadata/header flags do not reliably set the
 * Cache-Control HTTP header on R2 objects, and its .ts mime detection is wrong.
 * This SDK-based uploader sets both deterministically at PUT time.
 *
 * Env: R2_ACCESS_KEY, R2_SECRET_KEY, CF_ACCOUNT_ID (or R2_ENDPOINT), R2_BUCKET.
 * Usage: node worker/scripts/upload-videos.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'dist');

function envOrDev(key) {
  if (process.env[key]) return process.env[key];
  try {
    const dv = fs.readFileSync(path.join(__dirname, '..', '.dev.vars'), 'utf8');
    const m = dv.match(new RegExp('^' + key + '=(.*)$', 'm'));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

const bucket = process.env.R2_BUCKET || 'mosaic-media';
// Default no-store guarantees correct CORS on direct responses. Once a
// Cloudflare Transform Rule forces ACAO on the media host, set this env to
// "public, max-age=31536000" to restore edge caching (fast playback).
const cacheControl = process.env.VIDEO_CACHE_CONTROL || 'no-store';
const accessKey = envOrDev('R2_ACCESS_KEY');
const secretKey = envOrDev('R2_SECRET_KEY');
const accountId = envOrDev('CF_ACCOUNT_ID');
if (!accessKey || !secretKey || !accountId) {
  console.error('R2 credentials not configured (R2_ACCESS_KEY/R2_SECRET_KEY/CF_ACCOUNT_ID)');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  forcePathStyle: true,
});

const CONTENT_TYPE = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

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
    const ext = path.extname(f).toLowerCase();
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: fs.createReadStream(filePath),
          CacheControl: cacheControl,
          ContentType: CONTENT_TYPE[ext] || 'application/octet-stream',
        }),
      );
      total++;
    } catch (e) {
      console.error(`  FAIL ${key}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
console.log(`Video upload complete: ${total} files (Cache-Control: no-store)`);
if (process.exitCode) process.exit(1);
