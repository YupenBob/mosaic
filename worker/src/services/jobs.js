import { normalizeConfig, processingConfig } from '../../../shared/config.mjs';
import { assetId, fingerprint, folderFor } from '../../../shared/media-manifest.mjs';
import { getConfig } from './site-config.js';
export async function jobsRequest(env, operation, body = {}) {
  if (!env.JOBS) throw new Error('JOBS binding is not configured; deploy the task coordinator first');
  const stub = env.JOBS.get(env.JOBS.idFromName(env.GITHUB_REPO || 'mosaic'));
  const response = await stub.fetch(
    new Request(`https://jobs.local/${operation}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error);
    error.status = response.status;
    throw error;
  }
  return result;
}
export async function registerUpload(c, key, object, extra = {}) {
  if (!c.env.JOBS || key.startsWith('site-data/')) return null; // rolling-upgrade compatibility
  const [, slug, folder, filename] = key.split('/');
  if (!['photos', 'videos', 'music', 'covers'].includes(folder || folderFor(filename))) return null;
  const config = normalizeConfig(await getConfig(c), c.env);
  return jobsRequest(c.env, 'enqueue', {
    id: assetId(slug, filename, folder),
    slug,
    filename,
    folder,
    ...extra,
    source: { key, etag: object.etag, size: object.size },
    config,
    configHash: await fingerprint(processingConfig(config, folder)),
  });
}
export async function invalidateMedia(env, slug, filename) {
  if (env.JOBS) await jobsRequest(env, 'delete', { slug, filename });
}
export async function reconcileMedia(c, force = false) {
  if (!c.env.JOBS) return { queued: 0 };
  const config = normalizeConfig(await getConfig(c), c.env);
  return jobsRequest(c.env, 'reconcile', { config, force });
}
