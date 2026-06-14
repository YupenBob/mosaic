/**
 * R2 Presigned URL generation using Cloudflare's built-in S3 compatibility.
 * Browser uploads directly to R2 with the returned URL.
 */
import { AwsClient } from 'aws4fetch';

export async function generatePresignedUrl(c) {
  const { slug, filename, contentType } = await c.req.json().catch(() => ({}));
  if (!slug || !filename) return c.json({ error: 'slug and filename required', code: 'INVALID_PARAMS' }, 400);

  const key = `originals/${slug}/videos/${filename}`;
  const accountId = c.env.CF_ACCOUNT_ID || '';
  const accessKey = c.env.R2_ACCESS_KEY || '';
  const secretKey = c.env.R2_SECRET_KEY || '';
  const bucket = c.env.R2_BUCKET || 'mosaic-media';

  if (!accessKey || !secretKey) {
    // Fallback: use Worker's built-in R2 binding for direct upload
    return c.json({ url: `/api/upload/direct/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`, key, method: 'POST' });
  }

  const client = new AwsClient({
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    service: 's3',
    region: 'auto',
  });

  const url = new URL(`https://${bucket}.${accountId}.r2.cloudflarestorage.com/${key}`);
  const signed = await client.sign(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'video/mp4' },
    body: '',
  });

  return c.json({
    url: signed.url,
    key,
    expires: 3600,
    headers: signed.headers,
  });
}
