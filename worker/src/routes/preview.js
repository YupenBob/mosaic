/** Private preview endpoints (see services/preview.js). */
import {
  cleanupPreviews,
  createPreview,
  finishPreview,
  getPreviewStatus,
  readPreviewDraft,
  servePreview,
} from '../services/preview.js';
import { verifyPipelineSignature } from '../services/pipeline-signature.js';

export function registerPreviewPublic(app) {
  // Short-lived, unguessable preview site served straight from R2.
  app.get('/api/preview/:token', async (c) => servePreview(c, c.req.param('token'), ''));
  app.get('/api/preview/:token/*', async (c) => {
    const token = c.req.param('token');
    const prefix = `/api/preview/${token}`;
    return servePreview(c, token, c.req.path.slice(prefix.length));
  });

  // Workflow-only endpoints, authenticated by a pipeline HMAC signature. The
  // workflow never receives a standalone build token.
  app.post('/api/preview-build/draft', async (c) => {
    try {
      const raw = await c.req.text();
      if (!(await verifyPipelineSignature(c, raw))) return c.json({ error: 'Invalid pipeline signature' }, 401);
      return c.json(await readPreviewDraft(c, JSON.parse(raw)));
    } catch (error) {
      return c.json({ error: error.message }, error.status || 401);
    }
  });

  app.post('/api/preview-build/done', async (c) => {
    try {
      const raw = await c.req.text();
      if (!(await verifyPipelineSignature(c, raw))) return c.json({ error: 'Invalid pipeline signature' }, 401);
      return c.json(await finishPreview(c, JSON.parse(raw)));
    } catch (error) {
      return c.json({ error: error.message }, error.status || 401);
    }
  });
}

export function registerPreviewProtected(app) {
  app.post('/api/previews', async (c) => {
    try {
      const { draftId } = await c.req.json().catch(() => ({}));
      if (!draftId) return c.json({ error: 'draftId required', code: 'INVALID_PARAMS' }, 400);
      return c.json(await createPreview(c, draftId), 202);
    } catch (error) {
      return c.json({ error: error.message, code: error.code || 'PREVIEW_ERROR' }, error.status || 502);
    }
  });

  app.delete('/api/previews', async (c) => {
    try {
      return c.json(await cleanupPreviews(c));
    } catch (error) {
      return c.json({ error: error.message, code: 'PREVIEW_ERROR' }, error.status || 502);
    }
  });

  app.get('/api/previews/:id', async (c) => {
    try {
      return c.json(await getPreviewStatus(c, c.req.param('id')));
    } catch (error) {
      return c.json({ error: error.message, code: error.code || 'PREVIEW_ERROR' }, error.status || 502);
    }
  });
}
