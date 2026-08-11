/**
 * Site configuration read/write (deep-merged in github.js).
 */
import { getConfig, updateConfig, markDirty } from '../github.js';
import { defer } from '../shared.js';

export function registerConfig(app) {
  app.get('/api/config', async (c) => {
    try {
      const cfg = await getConfig(c);
      return c.json(cfg);
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });

  app.put('/api/config', async (c) => {
    try {
      const { message, ...config } = await c.req.json();
      const result = await updateConfig(c, config, message);
      defer(c, () => markDirty(c.env));
      return c.json({ ok: true, sha: result.content?.sha });
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });
}
