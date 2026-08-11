/**
 * Media endpoints — public file serving + direct upload; protected presign,
 * complete, list and delete.
 */
import { getConfig, markDirty } from '../github.js';
import {
  generatePresignedUrl,
  uploadComplete,
  startMultipartUpload,
  listMultipartParts,
  completeMultipartUpload,
  abortMultipartUpload,
  listMedia,
  serveMediaFile,
  uploadDirect,
  deleteMediaFile,
} from '../r2.js';
import { defer } from '../shared.js';

export function registerMediaPublic(app) {
  // Media file serving — public (uses R2_PUBLIC_URL or falls back to config.mediaBase)
  app.get('/api/media/file/:slug/:filename', async (c) => {
    let cfg = {};
    try {
      cfg = await getConfig(c);
    } catch {}
    return serveMediaFile(c, cfg.mediaBase);
  });

  // Upload — public (admin sends JWT in XHR)
  app.post('/api/upload/direct/:slug/:filename', async (c) => {
    const result = await uploadDirect(c);
    defer(c, () => markDirty(c.env));
    return result;
  });
}

export function registerMediaProtected(app) {
  // Upload
  app.post('/api/upload/presign', generatePresignedUrl);
  app.post('/api/upload/complete/:slug/:filename', uploadComplete);
  app.post('/api/upload/multipart/start', startMultipartUpload);
  app.post('/api/upload/multipart/parts', listMultipartParts);
  app.post('/api/upload/multipart/complete', completeMultipartUpload);
  app.post('/api/upload/multipart/abort', abortMultipartUpload);

  // Media list — from R2 (uses R2_PUBLIC_URL or falls back to config.mediaBase)
  app.get('/api/media/:slug/list', async (c) => {
    let cfg = {};
    try {
      cfg = await getConfig(c);
    } catch {}
    return listMedia(c, cfg.mediaBase);
  });

  // Delete a single media file (originals + processed)
  app.delete('/api/media/:slug/:file', async (c) => {
    const result = await deleteMediaFile(c);
    defer(c, () => markDirty(c.env));
    return result;
  });
}
