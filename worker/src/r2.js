/**
 * R2 Presigned URL generation + direct upload via Worker binding.
 */
import { AwsClient } from 'aws4fetch';

// Direct upload via Worker R2 binding — no CORS issues
export async function uploadDirect(c) {
  const slug = c.req.param('slug');
  const filename = decodeURIComponent(c.req.param('filename'));
  if (!slug || !filename) return c.json({ error: 'slug and filename required', code: 'INVALID_PARAMS' }, 400);

  const ext = filename.split('.').pop()?.toLowerCase();
  const folder = ['jpg','jpeg','png','webp','gif','svg'].includes(ext) ? 'photos'
    : ['mp4','mov','mkv','webm'].includes(ext) ? 'videos'
    : ['mp3','flac','wav','ogg'].includes(ext) ? 'music'
    : 'others';
  const key = `originals/${slug}/${folder}/${filename}`;
  const contentType = c.req.header('Content-Type') || 'application/octet-stream';

  await c.env.MEDIA.put(key, c.req.raw.body, { httpMetadata: { contentType } });
  return c.json({ ok: true, key, filename, folder });
}

// List media from R2 (not GitHub — shows uploaded files immediately)
export async function listMedia(c) {
  const slug = c.req.param('slug');
  const result = { photos: [], videos: [], music: [] };
  try {
    const list = await c.env.MEDIA.list({ prefix: `originals/${slug}/` });
    for (const obj of (list.objects || [])) {
      const name = obj.key.split('/').pop();
      if (!name || name.startsWith('.')) continue;
      const ext = name.split('.').pop()?.toLowerCase();
      if (['jpg','jpeg','png','webp','gif','svg'].includes(ext)) {
        result.photos.push({ name, url: `/api/media/file/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`, size: obj.size });
      } else if (['mp4','mov','mkv','webm'].includes(ext)) {
        result.videos.push({ name, url: `/api/media/file/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`, size: obj.size });
      } else if (['mp3','flac','wav','ogg'].includes(ext)) {
        result.music.push({ name, url: `/api/media/file/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`, size: obj.size });
      }
    }
  } catch (e) { /* return empty */ }
  return c.json(result);
}

// Serve a media file from R2
export async function serveMediaFile(c) {
  const slug = c.req.param('slug');
  const filename = c.req.param('filename');
  // Try common folders
  for (const folder of ['photos', 'videos', 'music', 'others']) {
    const key = `originals/${slug}/${folder}/${filename}`;
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
