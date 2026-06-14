/**
 * Publish route: POST /publish
 * Triggers a GitHub Actions workflow via repository_dispatch.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { triggerBuild } from '../services/github';
import type { Env } from '../types';

const publish = new Hono<{ Bindings: Env; Variables: { isAuthenticated: boolean } }>();

publish.use('*', authMiddleware);

/**
 * POST /publish
 * Trigger a site build by dispatching the GitHub Actions workflow.
 */
publish.post('/', async (c) => {
  const result = await triggerBuild(c.env);

  if (!result.ok) {
    return c.json({ error: result.error || 'Failed to trigger build' }, 500);
  }

  return c.json({ ok: true, message: 'Build triggered successfully' });
});

export default publish;
