/**
 * R2 Presigned URL generation + direct upload via Worker binding.
 */
import { AwsClient } from 'aws4fetch';
import { verifyToken } from './auth.js';

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

const EXT_CONTENT_TYPE = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  txt: 'text/plain', json: 'application/json', md: 'text/markdown',
};

// Direct upload via Worker R2 binding — no CORS issues
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
    return c.json({ error: 'File too large (max 2GB)', code: 'PAYLOAD_TOO_LARGE' }, 413);
  }

  const ext = filename.split('.').pop()?.toLowerCase();
  const folder = ['jpg','jpeg','png','webp','gif','svg'].includes(ext) ? 'photos'
    : ['mp4','mov','mkv','webm','avi'].includes(ext) ? 'videos'
    : ['mp3','flac','wav','ogg','m4a','aac'].includes(ext) ? 'music'
    : 'others';
  const contentType = EXT_CONTENT_TYPE[ext] || 'application/octet-stream';
  // site-data is a reserved namespace (favicon etc.): not a post slug, so it is
  // never picked up by the pipeline sync and never swept as an orphan.
  const isSiteData = slug === 'site-data';
  const key = isSiteData ? `site-data/${filename}` : `originals/${slug}/${folder}/${filename}`;

  await c.env.MEDIA.put(key, c.req.raw.body, { httpMetadata: { contentType } });
  return c.json({ ok: true, key, filename, folder: isSiteData ? 'site-data' : folder });
}

// Delete a media file across originals/ and processed/ (paginated)
export async function deleteMediaFile(c) {
  const slug = c.req.param('slug');
  const filename = c.req.param('file');
  if (!slug || !filename) return c.json({ error: 'slug and file required', code: 'INVALID_PARAMS' }, 400);
  let deleted = 0;
  for (const prefix of ['originals', 'processed']) {
    let cursor;
    do {
      const opts = { prefix: `${prefix}/${slug}/`, limit: 1000 };
      if (cursor) opts.cursor = cursor;
      const list = await c.env.MEDIA.list(opts);
      for (const obj of (list.objects || [])) {
        if (obj.key.split('/').pop() === filename) {
          await c.env.MEDIA.delete(obj.key);
          deleted++;
        }
      }
      cursor = list.truncated ? list.cursor : null;
    } while (cursor);
  }
  return c.json({ ok: true, deleted });
}

// List media from R2 — searches originals/
export async function listMedia(c, mediaBaseOverride) {
  const slug = c.req.param('slug');
  const r2Public = c.env.R2_PUBLIC_URL || mediaBaseOverride || '';
  const seen = new Set();
  const result = { photos: [], videos: [], music: [] };

  const folderFor = (name) => {
    const ext = name.split('.').pop()?.toLowerCase();
    if (['jpg','jpeg','png','webp','gif','svg'].includes(ext)) return 'photos';
    if (['mp4','mov','mkv','webm','avi'].includes(ext)) return 'videos';
    if (['mp3','flac','wav','ogg','m4a','aac'].includes(ext)) return 'music';
    return 'others';
  };

  const add = (name, size) => {
    if (seen.has(name)) return;
    seen.add(name);
    const folder = folderFor(name);
    const url = r2Public
      ? `${r2Public}/originals/${encodeURIComponent(slug)}/${folder}/${encodeURIComponent(name)}`
      : `/api/media/file/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`;
    const ext = name.split('.').pop()?.toLowerCase();
    if (['jpg','jpeg','png','webp','gif','svg'].includes(ext)) result.photos.push({ name, url, size });
    else if (['mp4','mov','mkv','webm','avi'].includes(ext)) result.videos.push({ name, url, size });
    else if (['mp3','flac','wav','ogg','m4a','aac'].includes(ext)) result.music.push({ name, url, size });
  };

  try {
    const list = await c.env.MEDIA.list({ prefix: `originals/${slug}/` });
    for (const obj of (list.objects || [])) {
      const name = obj.key.split('/').pop();
      if (!name || name.startsWith('.')) continue;
      add(name, obj.size);
    }
  } catch (e) { /* return empty */ }
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
            'ETag': obj.httpEtag || '',
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
              'ETag': obj.httpEtag || '',
            },
          });
        }
      } catch {}
    }
  }
  return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
}

// Presigned URL for large files (fallback)
export async function generatePresignedUrl(c) {
  const { slug, filename, contentType } = await c.req.json().catch(() => ({}));
  if (!slug || !filename) return c.json({ error: 'slug and filename required', code: 'INVALID_PARAMS' }, 400);

  const key = `originals/${slug}/videos/${filename}`;
  const accountId = c.env.CF_ACCOUNT_ID || '';
  const accessKey = c.env.R2_ACCESS_KEY || '';
  const secretKey = c.env.R2_SECRET_KEY || '';
  const bucket = c.env.R2_BUCKET || 'mosaic-media';

  if (!accessKey || !secretKey) {
    return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);
  }

  const client = new AwsClient({
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    service: 's3',
    region: 'auto',
  });

  const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`);
  const signed = await client.sign(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: '',
  });

  return c.json({ url: signed.url, key, expires: 3600, headers: signed.headers });
}
