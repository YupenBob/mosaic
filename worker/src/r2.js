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
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { verifyToken } from './auth.js';
import { adjustUsage } from './usage.js';
import { markDirty } from './github.js';

// Workers platform request-body limit (~100MB). Larger files must use the
// presigned direct-to-R2 upload path.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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

  const accountId = c.env.CF_ACCOUNT_ID || '';
  const accessKey = c.env.R2_ACCESS_KEY || '';
  const secretKey = c.env.R2_SECRET_KEY || '';
  const bucket = c.env.R2_BUCKET || 'mosaic-media';
  if (!accessKey || !secretKey || !accountId) {
    return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);
  }

  const key = mediaKey(slug, filename);
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });
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
