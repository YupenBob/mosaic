/**
 * Build routes: GET /build/status, GET /build/history
 * Queries GitHub Actions workflow run status.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { getLatestBuildStatus, getBuildHistory } from '../services/github';
import type { Env } from '../types';

const build = new Hono<{ Bindings: Env; Variables: { isAuthenticated: boolean } }>();

build.use('*', authMiddleware);

/**
 * GET /build/status
 * Returns the latest workflow run status.
 */
build.get('/status', async (c) => {
  const status = await getLatestBuildStatus(c.env);

  if (!status) {
    return c.json({ status: 'unknown', message: 'No builds found' });
  }

  return c.json(status);
});

/**
 * GET /build/history
 * Returns the last 20 build runs.
 */
build.get('/history', async (c) => {
  const history = await getBuildHistory(c.env);
  return c.json({ runs: history });
});

export default build;
