/** Coordinator client + upload registration helpers used by the Worker routes. */
import { normalizeConfig, processingConfig } from '../../../shared/config.mjs';
import { assetId, fingerprint, folderFor, validSegment } from '../../../shared/media-manifest.mjs';
import { getConfig } from './site-config.js';

/**
 * Call one operation on the Jobs Durable Object.
 * @param {object} env - Worker bindings
 * @param {string} operation - coordinator operation name
 * @param {object} [body]
 * @returns {Promise<object>}
 */
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

/**
 * Register an uploaded object as a media task. `extra.keepSource` (boolean)
 * becomes `job.options.keepSource`; absent means "use the site default", which
 * the coordinator resolves from config.media.keepSourceFiles.
 *
 * @param {object} c - Hono context
 * @param {string} key - R2 object key
 * @param {{etag:string, size:number}} object - HEAD result
 * @param {{uploadId?:string, keepSource?:boolean}} [extra]
 * @returns {Promise<object|null>}
 */
export async function registerUpload(c, key, object, extra = {}) {
  if (!c.env.JOBS || key.startsWith('site-data/')) return null; // rolling-upgrade compatibility
  const [, slug, folder, filename] = key.split('/');
  if (!['photos', 'videos', 'music', 'covers'].includes(folder || folderFor(filename))) return null;
  const config = normalizeConfig(await getConfig(c), c.env);
  const { keepSource, options, ...rest } = extra;
  const jobOptions = { ...(options || {}) };
  if (keepSource !== undefined) jobOptions.keepSource = keepSource;
  return jobsRequest(c.env, 'enqueue', {
    id: assetId(slug, filename, folder),
    slug,
    filename,
    folder,
    ...rest,
    ...(Object.keys(jobOptions).length ? { options: jobOptions } : {}),
    source: { key, etag: object.etag, size: object.size },
    config,
    configHash: await fingerprint(processingConfig(config, folder)),
  });
}

/**
 * Register post-hoc interpolation tasks for decoded videos.
 *
 * Scope: `slug` (all videos of a post), `slug` + `filename` (one asset) or
 * `all: true` (every video in the manifest). Each task re-encodes the already
 * published tier MP4s in `processed` mode with a new generation; originals are
 * never required.
 *
 * @param {object} c - Hono context
 * @param {{slug?:string, filename?:string, all?:boolean, fps?:number}} body
 * @returns {Promise<{enqueued:number, tasks:object[], skipped:object[]}>}
 */
export async function interpolateMedia(c, body = {}) {
  if (!c.env.JOBS) throw Object.assign(new Error('JOBS binding is not configured'), { status: 503 });
  const all = body.all === true;
  const slug = body.slug;
  const filename = body.filename;
  if (!all && (typeof slug !== 'string' || !validSegment(slug)))
    throw Object.assign(new Error('slug is required unless all=true'), { status: 400, code: 'INVALID_PARAMS' });
  if (filename !== undefined && (typeof filename !== 'string' || !validSegment(filename)))
    throw Object.assign(new Error('filename is not a valid media name'), { status: 400, code: 'INVALID_PARAMS' });
  if (body.fps !== undefined && (!Number.isInteger(body.fps) || body.fps < 24 || body.fps > 120))
    throw Object.assign(new Error('fps must be an integer in 24..120'), { status: 400, code: 'INVALID_PARAMS' });
  const config = normalizeConfig(await getConfig(c), c.env);
  const effective = structuredClone(config);
  effective.videoQuality.interpolation = {
    ...config.videoQuality.interpolation,
    enabled: true,
    ...(body.fps !== undefined ? { fps: body.fps } : {}),
  };
  return jobsRequest(c.env, 'interpolate', {
    all,
    slug: all ? '' : slug,
    filename: filename || '',
    fps: body.fps ?? 0,
    config: effective,
    stateConfig: config,
    // Fingerprint from the site-wide config: per-job options are overrides, not
    // global processing settings (config reconciliation must not undo them).
    configHash: await fingerprint(processingConfig(config, 'videos')),
  });
}

/**
 * Mark one media asset as deleted and cancel its task.
 * @param {object} env
 * @param {string} slug
 * @param {string} [filename]
 */
export async function invalidateMedia(env, slug, filename) {
  if (env.JOBS) await jobsRequest(env, 'delete', { slug, filename });
}

/**
 * Queue a durable configuration reconciliation pass.
 * @param {object} c - Hono context
 * @param {boolean} [force] - re-queue even unchanged fingerprints
 * @returns {Promise<object>}
 */
export async function reconcileMedia(c, force = false) {
  if (!c.env.JOBS) return { queued: 0 };
  const config = normalizeConfig(await getConfig(c), c.env);
  return jobsRequest(c.env, 'reconcile', { config, force });
}
