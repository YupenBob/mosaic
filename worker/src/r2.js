/**
 * R2 upload + file serving.
 *
 * Upload strategy:
 * - Small files (<=100MB): Worker-mediated direct upload (uploadDirect) via the
 *   R2 binding. The Workers platform caps request bodies at ~100MB.
 * - Large files: presigned direct-to-R2 PUT (generatePresignedUrl) — the browser
 *   uploads straight to the R2 S3 endpoint, bypassing the Worker body relay.
 *   uploadComplete() verifies the object landed and marks the site dirty.
 */
import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { verifyToken } from './auth.js';
import { adjustUsage } from './usage.js';
import { markDirty } from './github.js';

// Workers platform request-body limit (~100MB). Larger files must use the
// presigned direct-to-R2 upload path.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// Multipart part size bounds (R2 allows up to 10,000 parts; 5MB..1GB per part).
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 1024 * 1024 * 1024;
const DEFAULT_PART_BYTES = 100 * 1024 * 1024;
const MAX_PARTS = 10000;

function s3Client(c) {
  const accountId = c.env.CF_ACCOUNT_ID || '';
  const accessKey = c.env.R2_ACCESS_KEY || '';
  const secretKey = c.env.R2_SECRET_KEY || '';
  if (!accessKey || !secretKey || !accountId) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
    // Fetch-based transport: same semantics in Workers, and lets Node tests
    // route S3 calls through the mocked global fetch.
    requestHandler: new FetchHttpHandler(),
  });
}

async function listUploadedParts(client, bucket, key, uploadId) {
  const parts = [];
  let marker;
  do {
    const res = await client.send(
      new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
    );
    for (const p of res.Parts || []) parts.push({ partNumber: p.PartNumber, size: p.Size, etag: p.ETag });
    marker = res.IsTruncated ? res.NextPartNumberMarker : null;
  } while (marker);
  return parts;
}

const EXT_CONTENT_TYPE = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  txt: 'text/plain',
  json: 'application/json',
  md: 'text/markdown',
};

function folderForExt(ext) {
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext)) return 'photos';
  if (['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) return 'videos';
  if (['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'].includes(ext)) return 'music';
  return 'others';
}

// site-data is a reserved namespace (favicon etc.): not a post slug, so it is
// never picked up by the pipeline sync and never swept as an orphan.
export function mediaKey(slug, filename) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return slug === 'site-data' ? `site-data/${filename}` : `originals/${slug}/${folderForExt(ext)}/${filename}`;
}

// Direct upload via Worker R2 binding — no CORS issues (<=100MB)
export async function uploadDirect(c) {
  const slug = c.req.param('slug');
  const filename = decodeURIComponent(c.req.param('filename'));
  if (!slug || !filename) return c.json({ error: 'slug and filename required', code: 'INVALID_PARAMS' }, 400);

  // Verify JWT inline (gives better CORS behavior for XHR uploads)
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const auth = await verifyToken(c, token);
  if (!auth.ok) {
    return c.json({ error: 'Unauthorized', code: auth.code }, auth.status);
  }

  const length = parseInt(c.req.header('Content-Length') || '0', 10);
  if (length > MAX_UPLOAD_BYTES) {
    return c.json(
      { error: 'File too large (max 100MB via Worker; use presigned upload above this)', code: 'PAYLOAD_TOO_LARGE' },
      413,
    );
  }

  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const folder = folderForExt(ext);
  const contentType = EXT_CONTENT_TYPE[ext] || 'application/octet-stream';
  const isSiteData = slug === 'site-data';
  const key = mediaKey(slug, filename);

  await c.env.MEDIA.put(key, c.req.raw.body, { httpMetadata: { contentType } });
  const obj = await c.env.MEDIA.head(key).catch(() => null);
  await adjustUsage(c.env, obj?.size ?? length, 1);
  return c.json({ ok: true, key, filename, folder: isSiteData ? 'site-data' : folder });
}

// Confirm a presigned direct upload landed in R2, then mark the site dirty.
export async function uploadComplete(c) {
  const slug = c.req.param('slug');
  const filename = decodeURIComponent(c.req.param('filename'));
  if (!slug || !filename) return c.json({ error: 'slug and filename required', code: 'INVALID_PARAMS' }, 400);
  const key = mediaKey(slug, filename);
  try {
    const obj = await c.env.MEDIA.head(key);
    if (!obj) return c.json({ error: 'Object not found', code: 'NOT_FOUND' }, 404);
    await markDirty(c.env);
    await adjustUsage(c.env, obj.size || 0, 1);
    return c.json({ ok: true, key, size: obj.size });
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 500);
  }
}

// Delete a media file across originals/ and processed/ (paginated)
export async function deleteMediaFile(c) {
  const slug = c.req.param('slug');
  const filename = c.req.param('file');
  if (!slug || !filename) return c.json({ error: 'slug and file required', code: 'INVALID_PARAMS' }, 400);
  let deleted = 0;
  let deletedSize = 0;
  for (const prefix of ['originals', 'processed']) {
    let cursor;
    do {
      const opts = { prefix: `${prefix}/${slug}/`, limit: 1000 };
      if (cursor) opts.cursor = cursor;
      const list = await c.env.MEDIA.list(opts);
      for (const obj of list.objects || []) {
        if (obj.key.split('/').pop() === filename) {
          deletedSize += obj.size || 0;
          await c.env.MEDIA.delete(obj.key);
          deleted++;
        }
      }
      cursor = list.truncated ? list.cursor : null;
    } while (cursor);
  }
  await adjustUsage(c.env, -deletedSize, -deleted);
  return c.json({ ok: true, deleted });
}

// List media from R2 — searches originals/
export async function listMedia(c, mediaBaseOverride) {
  const slug = c.req.param('slug');
  const r2Public = c.env.R2_PUBLIC_URL || mediaBaseOverride || '';
  const seen = new Set();
  const result = { photos: [], videos: [], music: [] };

  const add = (name, size) => {
    if (seen.has(name)) return;
    seen.add(name);
    const folder = folderForExt(name.split('.').pop()?.toLowerCase() || '');
    const url = r2Public
      ? `${r2Public}/originals/${encodeURIComponent(slug)}/${folder}/${encodeURIComponent(name)}`
      : `/api/media/file/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`;
    const ext = name.split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext)) result.photos.push({ name, url, size });
    else if (['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) result.videos.push({ name, url, size });
    else if (['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'].includes(ext)) result.music.push({ name, url, size });
  };

  try {
    const list = await c.env.MEDIA.list({ prefix: `originals/${slug}/` });
    for (const obj of list.objects || []) {
      const name = obj.key.split('/').pop();
      if (!name || name.startsWith('.')) continue;
      add(name, obj.size);
    }
  } catch (e) {
    /* return empty */
  }
  return c.json(result);
}

// Serve a media file from R2 (searches both originals/ and processed/)
export async function serveMediaFile(c) {
  const slug = c.req.param('slug');
  const filename = c.req.param('filename');

  // site-data namespace (favicon etc.)
  if (slug === 'site-data') {
    try {
      const obj = await c.env.MEDIA.get(`site-data/${filename}`);
      if (obj) {
        return new Response(obj.body, {
          headers: {
            'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400',
            ETag: obj.httpEtag || '',
            // Media fetched via hls.js (XHR/fetch) requires CORS; R2's own
            // edge responses sometimes omit it on cached range responses.
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    } catch {}
    return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
  }

  // Search order: processed (compressed) first, then originals
  const prefixes = ['processed', 'originals'];
  const folders = ['photos', 'videos', 'music', 'covers', 'others'];

  for (const prefix of prefixes) {
    for (const folder of folders) {
      const key = `${prefix}/${slug}/${folder}/${filename}`;
      try {
        const obj = await c.env.MEDIA.get(key);
        if (obj) {
          return new Response(obj.body, {
            headers: {
              'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
              'Cache-Control': 'public, max-age=31536000',
              ETag: obj.httpEtag || '',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      } catch {}
    }
  }
  return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
}

// Presigned direct upload: browser → R2 S3 endpoint (single hop, >100MB capable)
export async function generatePresignedUrl(c) {
  const { slug, filename, contentType } = await c.req.json().catch(() => ({}));
  if (!slug || !filename) return c.json({ error: 'slug and filename required', code: 'INVALID_PARAMS' }, 400);

  const client = s3Client(c);
  if (!client) {
    return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);
  }

  const bucket = c.env.R2_BUCKET || 'mosaic-media';
  const key = mediaKey(slug, filename);
  // ContentType intentionally NOT signed so the browser may send its own
  // Content-Type without breaking the SigV4 signature match.
  const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 });
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const folder = slug === 'site-data' ? 'site-data' : folderForExt(ext);
  return c.json({
    url,
    key,
    folder,
    expires: 3600,
    contentType: contentType || EXT_CONTENT_TYPE[ext] || 'application/octet-stream',
  });
}

/**
 * Start (or resume) a multipart upload for large files.
 * Pass an existing uploadId to re-sign part URLs for that upload (resume);
 * otherwise a new multipart upload is created.
 */
export async function startMultipartUpload(c) {
  const { slug, filename, contentType, size, partSize, uploadId } = await c.req.json().catch(() => ({}));
  if (!slug || !filename) return c.json({ error: 'slug and filename required', code: 'INVALID_PARAMS' }, 400);
  const client = s3Client(c);
  if (!client) return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);

  const bucket = c.env.R2_BUCKET || 'mosaic-media';
  const key = mediaKey(slug, filename);
  const partBytes = Math.min(MAX_PART_BYTES, Math.max(MIN_PART_BYTES, parseInt(partSize) || DEFAULT_PART_BYTES));
  const totalSize = Math.max(1, parseInt(size) || 0);
  const partCount = Math.min(MAX_PARTS, Math.max(1, Math.ceil(totalSize / partBytes)));

  let id = uploadId || '';
  if (!id) {
    const created = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType || undefined }),
    );
    if (!created.UploadId) return c.json({ error: 'Multipart upload creation failed', code: 'R2_ERROR' }, 500);
    id = created.UploadId;
  } else {
    // Resume: verify the upload still exists before handing out part URLs.
    try {
      await listUploadedParts(client, bucket, key, id);
    } catch {
      return c.json({ error: 'Upload not found', code: 'NOT_FOUND' }, 404);
    }
  }

  const parts = [];
  for (let i = 1; i <= partCount; i++) {
    const url = await getSignedUrl(
      client,
      new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: id, PartNumber: i }),
      { expiresIn: 3600 },
    );
    parts.push({ partNumber: i, url });
  }
  return c.json({ ok: true, uploadId: id, key, partSize: partBytes, partCount, parts, expires: 3600 });
}

// List already-uploaded parts (client uses this to skip them on resume).
export async function listMultipartParts(c) {
  const { slug, filename, uploadId } = await c.req.json().catch(() => ({}));
  if (!slug || !filename || !uploadId) {
    return c.json({ error: 'slug, filename and uploadId required', code: 'INVALID_PARAMS' }, 400);
  }
  const client = s3Client(c);
  if (!client) return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);
  const bucket = c.env.R2_BUCKET || 'mosaic-media';
  const key = mediaKey(slug, filename);
  try {
    const parts = await listUploadedParts(client, bucket, key, uploadId);
    return c.json({ ok: true, parts });
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 500);
  }
}

// Complete a multipart upload (server assembles parts from R2) and mark dirty.
export async function completeMultipartUpload(c) {
  const { slug, filename, uploadId } = await c.req.json().catch(() => ({}));
  if (!slug || !filename || !uploadId) {
    return c.json({ error: 'slug, filename and uploadId required', code: 'INVALID_PARAMS' }, 400);
  }
  const client = s3Client(c);
  if (!client) return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);
  const bucket = c.env.R2_BUCKET || 'mosaic-media';
  const key = mediaKey(slug, filename);
  try {
    const parts = await listUploadedParts(client, bucket, key, uploadId);
    if (!parts.length) return c.json({ error: 'No parts uploaded', code: 'INVALID_PARTS' }, 400);
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
    const obj = await c.env.MEDIA.head(key).catch(() => null);
    await markDirty(c.env);
    await adjustUsage(c.env, obj?.size || 0, 1);
    return c.json({ ok: true, key, size: obj?.size || 0 });
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 500);
  }
}

// Abort a multipart upload (cleanup when the client cancels).
export async function abortMultipartUpload(c) {
  const { slug, filename, uploadId } = await c.req.json().catch(() => ({}));
  if (!slug || !filename || !uploadId) {
    return c.json({ error: 'slug, filename and uploadId required', code: 'INVALID_PARAMS' }, 400);
  }
  const client = s3Client(c);
  if (!client) return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);
  const bucket = c.env.R2_BUCKET || 'mosaic-media';
  const key = mediaKey(slug, filename);
  try {
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 500);
  }
}
