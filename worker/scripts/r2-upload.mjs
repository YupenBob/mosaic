/**
 * Shared R2 upload helpers for the video pipeline.
 *
 * Used by:
 *   - scripts/compress.js            (streaming per-tier uploads while transcoding)
 *   - worker/scripts/upload-videos.mjs (final reconcile: HEAD-skip, PUT missing)
 *
 * Env: R2_ACCESS_KEY, R2_SECRET_KEY, CF_ACCOUNT_ID (or R2_ENDPOINT), R2_BUCKET.
 * Bare imports of '@aws-sdk/client-s3' resolve from worker/node_modules.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function envOrDev(key) {
  if (process.env[key]) return process.env[key];
  try {
    const dv = fs.readFileSync(path.join(__dirname, '..', '.dev.vars'), 'utf8');
    const m = dv.match(new RegExp('^' + key + '=(.*)$', 'm'));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

export const DEFAULT_BUCKET = process.env.R2_BUCKET || 'mosaic-media';

const CONTENT_TYPE = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPE[ext] || 'application/octet-stream';
}

export function canUpload() {
  return !!(
    envOrDev('R2_ACCESS_KEY') &&
    envOrDev('R2_SECRET_KEY') &&
    (envOrDev('CF_ACCOUNT_ID') || envOrDev('R2_ENDPOINT'))
  );
}

let _client = null;
export function getClient() {
  if (_client) return _client;
  const accessKey = envOrDev('R2_ACCESS_KEY');
  const secretKey = envOrDev('R2_SECRET_KEY');
  const accountId = envOrDev('CF_ACCOUNT_ID');
  const endpoint = accountId ? `https://${accountId}.r2.cloudflarestorage.com` : envOrDev('R2_ENDPOINT');
  if (!accessKey || !secretKey || !endpoint) {
    throw new Error('R2 credentials not configured (R2_ACCESS_KEY/R2_SECRET_KEY/CF_ACCOUNT_ID or R2_ENDPOINT)');
  }
  _client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });
  return _client;
}

export async function uploadFile({ key, filePath, cacheControl = 'no-store', bucket = DEFAULT_BUCKET }) {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      CacheControl: cacheControl,
      ContentType: contentTypeFor(filePath),
    }),
  );
}

/** Returns the object size (number) when it exists, else null. */
export async function headObject(key, bucket = DEFAULT_BUCKET) {
  try {
    const client = getClient();
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return typeof res.ContentLength === 'number' ? res.ContentLength : 0;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/** Returns { size, cacheControl, contentType } for an object, or null when it does not exist. */
export async function headObjectMeta(key, bucket = DEFAULT_BUCKET) {
  try {
    const client = getClient();
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      size: typeof res.ContentLength === 'number' ? res.ContentLength : 0,
      cacheControl: typeof res.CacheControl === 'string' ? res.CacheControl : '',
      contentType: typeof res.ContentType === 'string' ? res.ContentType : 'application/octet-stream',
    };
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/**
 * List all processed video object keys in the bucket (paginated). Independent
 * of local dist files, so cache-control refreshes work on cache-hit builds.
 */
export async function listVideoKeys(bucket = DEFAULT_BUCKET) {
  const client = getClient();
  const keys = [];
  let token;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: 'processed/', ContinuationToken: token }),
    );
    for (const obj of res.Contents || []) {
      const key = obj.Key || '';
      if (/\.(m3u8|ts|mp4|m4s)$/i.test(key)) keys.push(key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/**
 * Rewrite only the HTTP metadata of an existing object (no data transfer) —
 * used to flip Cache-Control after the media CORS Transform Rule goes live.
 * MetadataDirective REPLACE requires supplying the full metadata set.
 */
export async function copyWithCacheControl({ key, cacheControl, contentType, bucket = DEFAULT_BUCKET }) {
  const client = getClient();
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: key,
      CopySource: `${bucket}/${key}`,
      MetadataDirective: 'REPLACE',
      CacheControl: cacheControl,
      ContentType: contentType,
    }),
  );
}
