/**
 * Health endpoints — real probes for GitHub/R2 reachability.
 */
import { VERSION, HEALTH_TIMEOUT_MS } from '../shared.js';

export function registerHealth(app) {
  app.get('/api/health', (c) => c.json({ status: 'ok', ok: true, version: VERSION }));

  app.get('/api/health/github', async (c) => {
    const started = Date.now();
    try {
      const resp = await fetch('https://api.github.com/rate_limit', {
        headers: {
          Authorization: `Bearer ${c.env.GITHUB_TOKEN || ''}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Mosaic-Worker/1.0',
        },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      // 403 = reachable but rate-limited/no scope; GitHub itself is healthy.
      const ok = resp.ok || resp.status === 403;
      return c.json({ status: ok ? 'ok' : 'error', ok, latency: Date.now() - started, httpStatus: resp.status });
    } catch (e) {
      return c.json({
        status: 'error',
        ok: false,
        latency: Date.now() - started,
        error: e.name === 'TimeoutError' ? 'timeout' : e.message,
      });
    }
  });

  app.get('/api/health/r2', async (c) => {
    const started = Date.now();
    try {
      await c.env.MEDIA.head('site-data/health-probe');
      return c.json({ status: 'ok', ok: true, latency: Date.now() - started });
    } catch (e) {
      return c.json({ status: 'error', ok: false, latency: Date.now() - started, error: e.message });
    }
  });
}
