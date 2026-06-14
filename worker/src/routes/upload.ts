/**
 * Upload routes: POST /upload/init, POST /upload/complete, GET /upload/status/:id
 *
 * Upload flow:
 * 1. Client POSTs /upload/init with slug + file list
 * 2. Worker generates presigned PUT URLs for direct R2 upload
 * 3. Client uploads directly to R2 using the presigned URLs
 * 4. Client POSTs /upload/complete to confirm
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { buildKey } from '../services/r2';
import type { Env, UploadInitRequest, UploadInitResponse, UploadStatus } from '../types';

const upload = new Hono<{ Bindings: Env; Variables: { isAuthenticated: boolean } }>();

// All upload routes require authentication
upload.use('*', authMiddleware);

/**
 * POST /upload/init
 * Initialize an upload session. Returns presigned URLs for direct R2 upload.
 */
upload.post('/init', async (c) => {
  const body = await c.req.json<UploadInitRequest>();

  if (!body.slug || !body.files || !Array.isArray(body.files)) {
    return c.json({ error: 'slug and files[] required' }, 400);
  }

  const uploadId = `upload_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const files: UploadInitResponse['files'] = [];

  for (const file of body.files) {
    const category = file.type === 'cover' ? 'covers' : file.type;
    const key = buildKey(body.slug, 'originals', category as 'photos' | 'videos' | 'music', file.name);

    // Generate presigned URL for direct R2 upload
    const presignedUrl = await generateR2PresignedUrl(c.env, key, file.contentType);

    files.push({
      name: file.name,
      presignedUrl,
      key,
    });
  }

  // Store upload session in KV (TTL: 30 minutes)
  const session: UploadStatus = {
    id: uploadId,
    slug: body.slug,
    status: 'pending',
    files: body.files.map((f) => ({ name: f.name, uploaded: false })),
    createdAt: new Date().toISOString(),
  };

  await c.env.AUTH.put(
    `upload:${uploadId}`,
    JSON.stringify(session),
    { expirationTtl: 1800 }
  );

  return c.json({ uploadId, files } satisfies UploadInitResponse);
});

/**
 * POST /upload/complete
 * Mark an upload session as complete after client has uploaded files to R2.
 */
upload.post('/complete', async (c) => {
  const { uploadId } = await c.req.json<{ uploadId: string }>();

  if (!uploadId) {
    return c.json({ error: 'uploadId required' }, 400);
  }

  const raw = await c.env.AUTH.get(`upload:${uploadId}`);
  if (!raw) {
    return c.json({ error: 'Upload session not found or expired' }, 404);
  }

  const session: UploadStatus = JSON.parse(raw);
  session.status = 'completed';
  await c.env.AUTH.put(`upload:${uploadId}`, JSON.stringify(session), { expirationTtl: 86400 });

  return c.json({ status: 'ok', uploadId });
});

/**
 * GET /upload/status/:id
 * Query the status of an upload session.
 */
upload.get('/status/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.env.AUTH.get(`upload:${id}`);

  if (!raw) {
    return c.json({ error: 'Upload session not found' }, 404);
  }

  return c.json(JSON.parse(raw) as UploadStatus);
});

/**
 * Generate a presigned URL for R2 upload using the S3 API compatibility.
 */
async function generateR2PresignedUrl(
  env: Env,
  key: string,
  contentType: string
): Promise<string> {
  // R2 presigned URL generation using the S3-compatible REST API
  // Build a pre-signed URL with simple query-string auth
  const bucketName = 'mosaic-media';
  const accountId = ''; // Retrieved from env or endpoint

  // Use the R2 public URL as base
  const baseUrl = env.R2_PUBLIC_URL
    ? new URL(env.R2_PUBLIC_URL).origin
    : 'https://mosaic-media.r2.cloudflarestorage.com';

  // For Worker-bound R2 buckets, we generate upload URLs
  // In production, use @aws-sdk/s3-request-presigner
  // For now, return a direct upload URL pattern
  const uploadUrl = `${baseUrl}/${key}`;

  // Note: Full S3 Signature V4 presigned URL generation requires access key + secret key
  // which should be available in env. The simplified approach creates the URL structure.
  return uploadUrl;
}

export default upload;
