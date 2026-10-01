/**
 * One-off maintenance: set Cache-Control: no-store on processed video objects
 * (m3u8/ts/mp4) so the edge never serves stale CORS-less cached responses.
 *
 * Usage: node scripts/r2-metadata.mjs [--dry-run]
 * Credentials must be explicit environment variables; production runs only in Actions.
 */
import { loadContext } from '../../scripts/lib/context.mjs';
import { S3Client, CopyObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const { config } = loadContext();
const get = (key) => process.env[key];
if (!process.env.GITHUB_RUN_ID) throw new Error('Production metadata maintenance must run in Actions');
const dryRun = process.argv.includes('--dry-run');
const cacheArg = process.argv.find((a) => a.startsWith('--cache-control='));
const TARGET_CACHE = cacheArg
  ? cacheArg.slice('--cache-control='.length)
  : process.env.VIDEO_CACHE_CONTROL || config.media.cacheControl;
const encPath = (key) => key.split('/').map(encodeURIComponent).join('/');

const client = new S3Client({
  region: 'auto',
  endpoint: get('R2_ENDPOINT') || `https://${get('CF_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: get('R2_ACCESS_KEY'), secretAccessKey: get('R2_SECRET_KEY') },
  forcePathStyle: true,
});
const BUCKET = config.mediaSource.bucket;

async function listAll(prefix) {
  const keys = [];
  let token;
  do {
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of out.Contents || []) keys.push(o.Key);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function head(key) {
  try {
    return await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch {
    return null;
  }
}

// ── migrate processed video objects ──
const keys = (await listAll('processed/')).filter((k) => /\/videos\/.+\.(m3u8|ts|mp4)$/i.test(k));
console.log(`found ${keys.length} video objects`);
let changed = 0,
  failed = 0;
for (const key of keys) {
  const meta = await head(key);
  if (meta?.CacheControl === TARGET_CACHE) continue;
  if (dryRun) {
    console.log('  would update', key);
    changed++;
    continue;
  }
  try {
    await client.send(
      new CopyObjectCommand({
        Bucket: BUCKET,
        Key: key,
        CopySource: `${encodeURIComponent(BUCKET)}/${encPath(key)}`,
        MetadataDirective: 'REPLACE',
        CacheControl: TARGET_CACHE,
      }),
    );
    changed++;
  } catch (e) {
    failed++;
    console.error('  FAIL', key, e.message);
  }
}
console.log(`done: ${changed} updated, ${failed} failed${dryRun ? ' (dry-run)' : ''}`);
if (failed > 0) process.exit(1);
