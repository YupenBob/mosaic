/**
 * Build lifecycle: trigger, status/history/progress, done, cancel.
 */
import { dispatchBuild, getLatestRun, getRunById, getRunHistory, cancelRun, isDirty } from '../github.js';
import { verifyToken } from '../auth.js';
import { jobsRequest } from '../services/jobs.js';

export function registerBuild(app) {
  // Build
  app.post('/api/build', async (c) => {
    try {
      // Check if build is already running
      const latest = await getLatestRun(c);
      if (latest && latest.status === 'in_progress') {
        return c.json(
          { error: 'Build already in progress', code: 'BUILD_RUNNING', run: { id: latest.id, url: latest.html_url } },
          409,
        );
      }
      await dispatchBuild(c);
      return c.json({ ok: true, message: 'Build triggered' });
    } catch (e) {
      return c.json({ error: e.message, code: 'DISPATCH_ERROR' }, 502);
    }
  });

  app.get('/api/build/history', async (c) => {
    try {
      const runs = await getRunHistory(c);
      return c.json({ runs });
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });

  // Compatibility endpoint: only the authenticated pipeline can acknowledge deployment.
  app.post('/api/build/done', async (c) => {
    try {
      const authHeader = c.req.header('Authorization') || '';
      const token = authHeader.replace('Bearer ', '');
      const auth = await verifyToken(c, token);
      if (!auth.ok) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, auth.status || 401);
      // Kept for older admin clients. Browser reports cannot acknowledge deployment.
      return c.json({ ok: true, dirty: !!(await isDirty(c.env)), acknowledged: false });
    } catch (e) {
      return c.json({ error: e.message, code: 'BUILD_DONE_ERROR' }, 502);
    }
  });

  // Cancel the latest running build (GitHub Actions run).
  app.post('/api/build/cancel', async (c) => {
    try {
      const authHeader = c.req.header('Authorization') || '';
      const auth = await verifyToken(c, authHeader.replace('Bearer ', ''));
      if (!auth.ok) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, auth.status || 401);
      const result = await cancelRun(c);
      if (!result.ok) return c.json({ error: result.error, code: 'CANCEL_FAILED' }, result.status || 400);
      return c.json({ ok: true, runNumber: result.runNumber });
    } catch (e) {
      return c.json({ error: e.message, code: 'CANCEL_ERROR' }, 502);
    }
  });

  app.get('/api/build/status', async (c) => {
    try {
      const run = await getLatestRun(c);
      if (!run) return c.json({ status: 'unknown' });
      return c.json(run);
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });

  // Single build run detail (metadata + step timeline) by GitHub run id.
  app.get('/api/build/run/:id', async (c) => {
    try {
      const run = await getRunById(c, c.req.param('id'));
      if (!run) return c.json({ error: 'Build run not found', code: 'NOT_FOUND' }, 404);
      return c.json(run);
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });

  // Live build progress reported by the pipeline (R2 site-data/build-progress.json)
  app.get('/api/build/progress', async (c) => {
    try {
      if (c.env.JOBS) {
        const state = await jobsRequest(c.env, 'build-state');
        const latest = state.builds.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
        return c.json(
          latest
            ? { ...latest, updatedAt: latest.updatedAt || latest.finishedAt || latest.startedAt }
            : { stage: '', updatedAt: null },
        );
      }
      const obj = await c.env.MEDIA.get('site-data/build-progress.json');
      if (!obj) return c.json({ stage: '', updatedAt: null });
      const data = JSON.parse(await obj.text());
      return c.json(data);
    } catch (e) {
      return c.json({ error: e.message, code: 'R2_ERROR' }, 502);
    }
  });
}
