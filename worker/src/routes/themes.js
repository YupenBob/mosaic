/** Theme package listing and apply (config commit). */
import { applyTheme, listThemes } from '../services/themes.js';

export function registerThemes(app) {
  app.get('/api/themes', async (c) => {
    try {
      return c.json(await listThemes(c));
    } catch (error) {
      return c.json({ error: error.message, code: 'THEME_ERROR' }, error.status || 502);
    }
  });

  app.post('/api/themes/apply', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      if (!body.id) return c.json({ error: 'theme id required', code: 'INVALID_PARAMS' }, 400);
      return c.json(await applyTheme(c, body.id, body.options || {}));
    } catch (error) {
      return c.json({ error: error.message, code: error.code || 'THEME_ERROR' }, error.status || 502);
    }
  });
}
