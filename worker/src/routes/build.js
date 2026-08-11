/**
 * Build lifecycle: trigger, status/history/progress, done, cancel.
 */
import { dispatchBuild, getLatestRun, cancelRun, clearDirty, markDirty } from '../github.js';
import { verifyToken } from '../auth.js';
import { defer } from '../shared.js';

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
      defer(c, () => clearDirty(c.env));
      return c.json({ ok: true, message: 'Build triggered' });
    } catch (e) {
      return c.json({ error: e.message, code: 'DISPATCH_ERROR' }, 502);
    }
  });

  app.get('/api/build/history', async (c) => {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${c.env.GITHUB_REPO}/actions/workflows/pipeline.yml/runs?per_page=10`,
        {
          headers: {
            Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Mosaic/0.8',
          },
        },
      );
      if (!resp.ok) return c.json({ runs: [] });
      const data = await resp.json();
      const repo = c.env.GITHUB_REPO;
      return c.json({
        runs: (data.workflow_runs || []).map((r) => ({
          id: r.id,
          runNumber: r.run_number,
          status: r.status,
          conclusion: r.conclusion,
          displayTitle: r.display_title,
          headBranch: r.head_branch,
          headSha: r.head_sha?.slice(0, 7),
          headShaFull: r.head_sha || '',
          commitUrl: r.head_sha ? `https://github.com/${repo}/commit/${r.head_sha}` : '',
          commitMessage: r.head_commit?.message?.split('\n')[0] || '',
          htmlUrl: r.html_url,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          event: r.event,
        })),
      });
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });

  // Build completion hook — clears the dirty flag on success, re-marks it on
  // failure, so the admin banner reflects "changes not yet deployed" correctly.
  // Authenticated with an admin JWT (the pipeline may later pass a shared secret).
  app.post('/api/build/done', async (c) => {
    try {
      const authHeader = c.req.header('Authorization') || '';
      const token = authHeader.replace('Bearer ', '');
      const auth = await verifyToken(c, token);
      if (!auth.ok) return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, auth.status || 401);
      const body = await c.req.json().catch(() => ({}));
      if (body.success === false) {
        await markDirty(c.env);
        return c.json({ ok: true, dirty: true });
      }
      await clearDirty(c.env);
      return c.json({ ok: true, dirty: false });
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

  // Live build progress reported by the pipeline (R2 site-data/build-progress.json)
  app.get('/api/build/progress', async (c) => {
    try {
      const obj = await c.env.MEDIA.get('site-data/build-progress.json');
      if (!obj) return c.json({ stage: '', updatedAt: null });
      const data = JSON.parse(await obj.text());
      return c.json(data);
    } catch (e) {
      return c.json({ error: e.message, code: 'R2_ERROR' }, 502);
    }
  });
}
