import { jobsRequest, reconcileMedia } from '../services/jobs.js';
import { GITHUB_API, headers } from '../services/github-client.js';

async function pipelineAuth(c, next) {
  const secret = c.env.PIPELINE_SECRET;
  if (!secret) return c.json({ error: 'PIPELINE_SECRET is not configured' }, 503);
  const timestamp = c.req.header('X-Mosaic-Time') || '';
  const signature = c.req.header('X-Mosaic-Signature') || '';
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > 300000 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return c.json({ error: 'Invalid pipeline signature' }, 401);
  const body = await c.req.text();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const bytes = Uint8Array.from(signature.match(/../g), (pair) => parseInt(pair, 16));
  if (!(await crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(`${timestamp}.${body}`))))
    return c.json({ error: 'Invalid pipeline signature' }, 401);
  await next();
}
export function registerInternalJobs(app) {
  app.use('/api/internal/*', pipelineAuth);
  app.post('/api/internal/media/:operation', async (c) => {
    try {
      const operation = c.req.param('operation');
      if (!['claim', 'heartbeat', 'publish', 'complete', 'failed', 'import', 'state'].includes(operation))
        return c.json({ error: 'Unknown operation' }, 404);
      return c.json(await jobsRequest(c.env, operation, await c.req.json()));
    } catch (error) {
      return c.json({ error: error.message }, error.status || 502);
    }
  });
  app.post('/api/internal/site/:operation', async (c) => {
    try {
      const data = await c.req.json(),
        operation = c.req.param('operation');
      if (!['begin', 'progress', 'done'].includes(operation)) return c.json({ error: 'Unknown operation' }, 404);
      if (operation === 'begin') {
        const state = await jobsRequest(c.env, 'state');
        if (state.dirty.gitSha && state.dirty.gitSha !== data.gitSha) {
          const response = await fetch(
            `${GITHUB_API}/repos/${c.env.GITHUB_REPO}/compare/${state.dirty.gitSha}...${data.gitSha}`,
            { headers: headers(c) },
          );
          const comparison = response.ok ? await response.json() : null;
          data.coversContent = !!comparison && ['ahead', 'identical'].includes(comparison.status);
        }
      }
      return c.json(await jobsRequest(c.env, `build-${operation}`, data));
    } catch (error) {
      return c.json({ error: error.message }, error.status || 502);
    }
  });
}
export function registerMediaJobs(app) {
  app.get('/api/media-jobs', async (c) => {
    try {
      return c.json(await jobsRequest(c.env, 'jobs-list'));
    } catch (error) {
      return c.json({ error: error.message }, 503);
    }
  });
  app.get('/api/media-jobs/:id', async (c) => {
    try {
      return c.json(await jobsRequest(c.env, 'job', { id: c.req.param('id') }));
    } catch (error) {
      return c.json({ error: error.message }, error.status || 503);
    }
  });
  for (const operation of ['retry', 'cancel'])
    app.post(`/api/media-jobs/:id/${operation}`, async (c) => {
      try {
        return c.json(await jobsRequest(c.env, operation, { id: c.req.param('id') }));
      } catch (error) {
        return c.json({ error: error.message }, error.status || 502);
      }
    });
  app.post('/api/media-jobs/reconcile', async (c) => {
    try {
      return c.json({ ok: true, ...(await reconcileMedia(c)) });
    } catch (error) {
      return c.json({ error: error.message }, error.status || 502);
    }
  });
}
