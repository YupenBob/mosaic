/** Cloud draft API (R2-backed, protected by the admin session). */
import { createDraft, deleteDraft, getDraft, listDrafts, publishDraft, saveDraft } from '../services/drafts.js';

function errorResponse(c, error) {
  return c.json({ error: error.message, code: error.code || 'DRAFT_ERROR' }, error.status || 500);
}

export function registerDrafts(app) {
  app.get('/api/drafts', async (c) => {
    try {
      return c.json({ drafts: await listDrafts(c) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/api/drafts', async (c) => {
    try {
      return c.json(await createDraft(c, await c.req.json().catch(() => ({}))), 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get('/api/drafts/:id', async (c) => {
    try {
      return c.json(await getDraft(c, c.req.param('id')));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.put('/api/drafts/:id', async (c) => {
    try {
      return c.json(await saveDraft(c, c.req.param('id'), await c.req.json().catch(() => ({}))));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post('/api/drafts/:id/publish', async (c) => {
    try {
      return c.json(await publishDraft(c, c.req.param('id')));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.delete('/api/drafts/:id', async (c) => {
    try {
      return c.json(await deleteDraft(c, c.req.param('id')));
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
