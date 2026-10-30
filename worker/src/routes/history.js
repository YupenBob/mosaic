/** Git history endpoints: list, detail and restore. */
import { getHistoryCommit, listHistory, restoreHistory } from '../services/history.js';

export function registerHistory(app) {
  app.get('/api/history', async (c) => {
    try {
      return c.json({ commits: await listHistory(c, c.req.query('limit')) });
    } catch (error) {
      return c.json({ error: error.message, code: 'HISTORY_ERROR' }, error.status || 502);
    }
  });

  app.get('/api/history/:sha', async (c) => {
    try {
      return c.json(await getHistoryCommit(c, c.req.param('sha')));
    } catch (error) {
      return c.json({ error: error.message, code: error.code || 'HISTORY_ERROR' }, error.status || 502);
    }
  });

  app.post('/api/history/:sha/restore', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      return c.json(await restoreHistory(c, c.req.param('sha'), body.path || ''));
    } catch (error) {
      return c.json({ error: error.message, code: error.code || 'HISTORY_ERROR' }, error.status || 502);
    }
  });
}
