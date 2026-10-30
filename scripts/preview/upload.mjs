/** Upload a built preview directory to R2 under previews/<previewId>/. */
import fs from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const directory = process.argv[2] || 'dist';
const previewId = process.env.PREVIEW_ID;
const bucket = process.env.R2_BUCKET;
const endpoint =
  process.env.R2_ENDPOINT ||
  (process.env.CF_ACCOUNT_ID ? `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
if (!previewId || !bucket || !endpoint || !process.env.R2_ACCESS_KEY || !process.env.R2_SECRET_KEY)
  throw new Error('PREVIEW_ID, R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY and R2_SECRET_KEY are required');
if (!/^prv_[a-z0-9]{26}$/.test(previewId)) throw new Error('Invalid preview id');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

const client = new S3Client({
  region: 'auto',
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY, secretAccessKey: process.env.R2_SECRET_KEY },
});

async function* walk(directoryPath) {
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const full = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

let uploaded = 0;
for await (const file of walk(path.resolve(directory))) {
  const relative = path.relative(path.resolve(directory), file).split(path.sep).join('/');
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `previews/${previewId}/${relative}`,
      Body: fs.createReadStream(file),
      ContentType: types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      CacheControl: 'no-store',
    }),
  );
  uploaded++;
}
console.log(`Uploaded ${uploaded} preview files`);
