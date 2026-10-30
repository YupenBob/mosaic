/**
 * Media v2 asset API.
 *
 * Uploads are direct-to-R2; the Worker only signs, verifies and enqueues. Asset
 * identities are independent of posts, so a file can exist before any article
 * links to it.
 */
import { newAssetId, ASSET_ID_RE } from '../../../shared/media-v2.mjs';
import {
  completeAssetUpload,
  generatePresignedUrl,
  startMultipartUpload,
  listMultipartParts,
  completeMultipartUpload,
  abortMultipartUpload,
} from '../r2.js';
import { jobsRequest } from '../services/jobs.js';

function assetIdParam(c) {
  const id = c.req.param('id');
  return ASSET_ID_RE.test(id) ? id : '';
}

export function registerAssetsPublic(app) {
  // Media itself is public; a random asset id makes the preview unguessable.
  app.get('/api/assets/:id/preview', async (c) => {
    const id = assetIdParam(c);
    if (!id) return c.json({ error: 'Invalid asset id', code: 'INVALID_PARAMS' }, 400);
    try {
      const { key } = await jobsRequest(c.env, 'asset-preview', { id });
      if (!key) return c.json({ error: 'No preview', code: 'NOT_FOUND' }, 404);
      const object = await c.env.MEDIA.get(key);
      if (!object) return c.json({ error: 'Preview missing', code: 'NOT_FOUND' }, 404);
      return new Response(object.body, {
        headers: {
          'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=300',
          ETag: object.httpEtag || '',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      return c.json({ error: error.message, code: 'JOBS_ERROR' }, 503);
    }
  });
}

export function registerAssets(app) {
  // Create an independent asset id and return a direct R2 PUT URL.
  app.post('/api/assets', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.filename !== 'string' || !body.filename)
      return c.json({ error: 'filename required', code: 'INVALID_PARAMS' }, 400);
    const assetIdValue = newAssetId();
    return generatePresignedUrl(c, { ...body, assetId: assetIdValue });
  });

  // Multipart flow for large files, keyed by the asset id.
  app.post('/api/assets/:id/multipart/start', async (c) => {
    const id = assetIdParam(c);
    if (!id) return c.json({ error: 'Invalid asset id', code: 'INVALID_PARAMS' }, 400);
    const body = await c.req.json().catch(() => ({}));
    return startMultipartUpload(c, { ...body, assetId: id });
  });

  app.post('/api/assets/:id/multipart/parts', async (c) => {
    const id = assetIdParam(c);
    if (!id) return c.json({ error: 'Invalid asset id', code: 'INVALID_PARAMS' }, 400);
    const body = await c.req.json().catch(() => ({}));
    return listMultipartParts(c, { ...body, assetId: id });
  });

  app.post('/api/assets/:id/multipart/complete', async (c) => {
    const id = assetIdParam(c);
    if (!id) return c.json({ error: 'Invalid asset id', code: 'INVALID_PARAMS' }, 400);
    const body = await c.req.json().catch(() => ({}));
    return completeMultipartUpload(c, { ...body, assetId: id });
  });

  app.post('/api/assets/:id/multipart/abort', async (c) => {
    const id = assetIdParam(c);
    if (!id) return c.json({ error: 'Invalid asset id', code: 'INVALID_PARAMS' }, 400);
    const body = await c.req.json().catch(() => ({}));
    return abortMultipartUpload(c, { ...body, assetId: id });
  });

  app.post('/api/assets/:id/complete', async (c) => {
    const id = assetIdParam(c);
    if (!id) return c.json({ error: 'Invalid asset id', code: 'INVALID_PARAMS' }, 400);
    return completeAssetUpload(c);
  });

  app.get('/api/assets', async (c) => {
    try {
      const ids = (c.req.query('ids') || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      const result = await jobsRequest(c.env, 'assets-list', {
        ids,
        status: c.req.query('status') || '',
        folder: c.req.query('folder') || '',
        includeDeleted: c.req.query('includeDeleted') === '1',
      });
      return c.json(result);
    } catch (error) {
      return c.json({ error: error.message, code: 'JOBS_ERROR' }, 503);
    }
  });

  app.delete('/api/assets/:id', async (c) => {
    const id = assetIdParam(c);
    if (!id) return c.json({ error: 'Invalid asset id', code: 'INVALID_PARAMS' }, 400);
    try {
      // Soft delete first: objects stay for the grace period and can be restored.
      const result = await jobsRequest(c.env, 'delete-assets', { ids: [id] });
      return c.json({ ...result, assetId: id });
    } catch (error) {
      return c.json({ error: error.message, code: 'JOBS_ERROR' }, 503);
    }
  });

  app.post('/api/assets/:id/restore', async (c) => {
    const id = assetIdParam(c);
    if (!id) return c.json({ error: 'Invalid asset id', code: 'INVALID_PARAMS' }, 400);
    try {
      const result = await jobsRequest(c.env, 'restore-assets', { ids: [id] });
      return c.json({ ...result, assetId: id });
    } catch (error) {
      return c.json({ error: error.message, code: 'JOBS_ERROR' }, 503);
    }
  });
}
