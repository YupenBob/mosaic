/**
 * One-off maintenance: set Cache-Control: no-store on processed video objects
 * (m3u8/ts/mp4) so the edge never serves stale CORS-less cached responses.
 *
 * Usage: node scripts/r2-metadata.mjs [--dry-run]
 * Credentials are read from ../.dev.vars (R2_ACCESS_KEY/R2_SECRET_KEY/CF_ACCOUNT_ID).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  S3Client, PutObjectCommand, CopyObjectCommand, HeadObjectCommand,
  ListObjectsV2Command, DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devVars = fs.readFileSync(path.join(__dirname, '..', '.dev.vars'), 'utf8');
const get = (k) => (devVars.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim();
const dryRun = process.argv.includes('--dry-run');
const encPath = (key) => key.split('/').map(encodeURIComponent).join('/');

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${get('CF_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: get('R2_ACCESS_KEY'), secretAccessKey: get('R2_SECRET_KEY') },
  forcePathStyle: true,
});
const BUCKET = 'mosaic-media';

async function listAll(prefix) {
  const keys = [];
  let token;
  do {
    const out = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of out.Contents || []) keys.push(o.Key);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function head(key) {
  try { return await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); }
  catch { return null; }
}

// ── self-test: copy metadata replace works on R2 ──
const TEST = 'processed/codex-meta-test/videos/probe.ts';
await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: TEST, Body: 'probe' }));
await client.send(new CopyObjectCommand({
  Bucket: BUCKET, Key: TEST, CopySource: `${encodeURIComponent(BUCKET)}/${encPath(TEST)}`,
  MetadataDirective: 'REPLACE', CacheControl: 'no-store',
}));
const h = await head(TEST);
await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: TEST }));
if (h?.CacheControl !== 'no-store') {
  console.error('CopyObject metadata replace FAILED:', h?.CacheControl);
  process.exit(1);
}
console.log('CopyObject metadata replace OK');

// ── migrate processed video objects ──
const keys = (await listAll('processed/')).filter((k) => /\/videos\/.+\.(m3u8|ts|mp4)$/i.test(k));
console.log(`found ${keys.length} video objects`);
let changed = 0, failed = 0;
for (const key of keys) {
  const meta = await head(key);
  if (meta?.CacheControl === 'no-store') continue;
  if (dryRun) { console.log('  would update', key); changed++; continue; }
  try {
    await client.send(new CopyObjectCommand({
      Bucket: BUCKET, Key: key, CopySource: `${encodeURIComponent(BUCKET)}/${encPath(key)}`,
      MetadataDirective: 'REPLACE', CacheControl: 'no-store',
    }));
    changed++;
  } catch (e) { failed++; console.error('  FAIL', key, e.message); }
}
console.log(`done: ${changed} updated, ${failed} failed${dryRun ? ' (dry-run)' : ''}`);
if (failed > 0) process.exit(1);
