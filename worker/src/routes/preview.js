/** Private preview endpoints (see services/preview.js). */
import { createPreview, finishPreview, getPreviewStatus, readPreviewDraft, servePreview } from '../services/preview.js';

export function registerPreviewPublic(app) {
  // Short-lived, unguessable preview site served straight from R2.
  app.get('/api/preview/:token', async (c) => servePreview(c, c.req.param('token'), ''));
  app.get('/api/preview/:token/*', async (c) => {
    const token = c.req.param('token');
    const prefix = `/api/preview/${token}`;
    return servePreview(c, token, c.req.path.slice(prefix.length));
  });

  // Workflow-only endpoints, authenticated by the build token.
  app.get('/api/preview-build/draft', async (c) => {
    try {
      return c.json(await readPreviewDraft(c, c.req.query('token')));
    } catch (error) {
      return c.json({ error: error.message }, error.status || 401);
    }
  });

  app.post('/api/preview-build/done', async (c) => {
    const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
    try {
      return c.json(await finishPreview(c, token, await c.req.json().catch(() => ({}))));
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

  app.get('/api/previews/:id', async (c) => {
    try {
      return c.json(await getPreviewStatus(c, c.req.param('id')));
    } catch (error) {
      return c.json({ error: error.message, code: error.code || 'PREVIEW_ERROR' }, error.status || 502);
    }
  });
}
