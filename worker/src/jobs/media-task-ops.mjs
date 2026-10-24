/**
 * Media-task lifecycle operations executed by the Jobs Durable Object:
 * registration (enqueue), deletion, legacy import, claim/lease, retry/cancel
 * and runner progress callbacks (heartbeat/publish/complete/failed).
 *
 * Extracted from `jobs-do.js` so the coordinator itself stays a thin,
 * serialized state owner. Every function receives a context with the loaded
 * state, the raw request payload, env, resolved config and the manifest-save
 * hooks, so behavior is identical to the previous inline implementation.
 */
import { fingerprint, objectKeys, validateManifest } from '../../../shared/media-manifest.mjs';
import { failJob, isJobDue } from './job-state.mjs';
import { isProcessedMode, normalizeJobOptions } from './media-options.mjs';
import { applySourceRetention } from './source-retention.mjs';

/**
 * @typedef {object} TaskContext
 * @property {object} state - coordinator state (mutated in place)
 * @property {object} data - request payload
 * @property {object} env - Worker bindings
 * @property {object} config - resolved site config
 * @property {(state: object) => Promise<void>} saveManifest
 * @property {(state: object, work: Function) => Promise<void>} batchManifest
 */

/**
 * Register/replace a media task for an uploaded source object.
 * @param {TaskContext} context
 * @returns {Promise<object>} task summary for the upload response
 */
export async function registerAsset({ state, data, config, saveManifest }) {
  // Legacy root covers now upload through photos/: retain their stable identity.
  const legacyCover = state.manifest.assets[`${data.slug}/covers/${data.filename}`];
  if (data.folder === 'photos' && legacyCover && legacyCover.status !== 'deleted' && !state.manifest.assets[data.id])
    data = { ...data, id: legacyCover.id, folder: 'covers' };
  // `state.config` tracks the site-wide config; per-job overrides live on the job.
  state.config = data.stateConfig || data.config;
  const normalizedOptions = normalizeJobOptions(data.options, data.stateConfig || data.config || config);
  const previous = state.manifest.assets[data.id];
  const current = previous && state.jobs[previous.jobId];
  if (
    !data.force &&
    previous?.source.etag === data.source.etag &&
    previous.configHash === data.configHash &&
    previous.status !== 'deleted' &&
    (current || previous.status === 'ready')
  )
    return { taskId: previous.jobId, status: current?.status || previous.status, duplicate: true };
  if (current) {
    current.status = 'superseded';
    current.lease = null;
  }
  const version = (previous?.version || 0) + 1,
    id = crypto.randomUUID();
  const generation = await fingerprint({ id: data.id, version, source: data.source.etag, config: data.configHash });
  const checkpoint =
    previous?.source.etag === data.source.etag && previous.configHash === data.configHash && !data.force
      ? previous.published || {}
      : {};
  const job = {
    ...data,
    options: normalizedOptions,
    id,
    assetId: data.id,
    version,
    generation,
    status: 'pending',
    attempts: 0,
    checkpoint,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.jobs[id] = job;
  state.manifest.assets[data.id] = {
    id: data.id,
    slug: data.slug,
    filename: data.filename,
    order: previous?.order ?? data.order ?? data.filename,
    folder: data.folder,
    version,
    generation,
    configHash: data.configHash,
    source: data.source,
    status: 'pending',
    jobId: id,
    published: previous?.published || null,
  };
  await saveManifest(state);
  return {
    taskId: id,
    status: 'pending',
    usageDelta: data.source.size - (previous?.source.size || 0),
    objectDelta: previous ? 0 : 1,
  };
}

/**
 * Mark every media asset matching a slug/filename as deleted and cancel its task.
 * @param {TaskContext} context
 * @returns {Promise<{ok:boolean}>}
 */
export async function removeAssets({ state, data, saveManifest }) {
  for (const asset of Object.values(state.manifest.assets)) {
    if (asset.slug !== data.slug || (data.filename && asset.filename !== data.filename)) continue;
    asset.status = 'deleted';
    const job = state.jobs[asset.jobId];
    if (job) {
      job.status = 'cancelled';
      job.lease = null;
    }
  }
  await saveManifest(state);
  return { ok: true };
}

/**
 * Import a validated legacy manifest: first import records a synthetic
 * deployment, then not-yet-ready assets are registered as tasks.
 * @param {TaskContext} context
 * @returns {Promise<{ok:boolean, revision:number}>}
 */
export async function importAssets({ state, data, env, config, saveManifest, batchManifest }) {
  state.config = data.config || state.config;
  const imported = validateManifest(data.manifest);
  const firstImport = !state.initialized;
  state.initialized = true;
  if (firstImport && !state.deployments.length)
    state.deployments.push({
      runId: 'legacy-migration',
      gitSha: data.previousGitSha || '',
      mediaRevision: state.manifest.revision + 1,
      success: true,
      legacy: true,
      finishedAt: new Date().toISOString(),
    });
  await batchManifest(state, async () => {
    for (const [id, asset] of Object.entries(imported.assets)) {
      if (state.manifest.assets[id]) continue;
      state.manifest.assets[id] = asset;
      // A source that no longer exists cannot be reprocessed; keep the imported
      // published asset but never queue a task that can only fail.
      if (asset.status !== 'ready' && asset.source?.available !== false)
        await registerAsset({ state, data: { ...asset, config: data.config || config }, env, config, saveManifest });
    }
    await saveManifest(state);
  });
  return { ok: true, revision: state.manifest.revision };
}

/**
 * Lease one due task to a media runner. Verifies the source/precondition first
 * through R2; processed-mode tasks are verified against their published tiers
 * instead (originals may have been deleted by keepSource=false).
 * @param {TaskContext} context
 * @returns {Promise<{job: object|null, more?: boolean, published?: object}>}
 */
export async function claimTask({ state, data, env }) {
  const job = Object.values(state.jobs).find((candidate) => isJobDue(candidate));
  if (!job) return { job: null };
  const asset = state.manifest.assets[job.assetId];
  if (asset?.status === 'deleted' || asset?.generation !== job.generation) {
    job.status = 'superseded';
    return { job: null, more: true };
  }
  if (isProcessedMode(job)) {
    const tiers = Object.keys(asset?.published?.sources || {});
    if (!tiers.length) {
      job.status = 'superseded';
      return { job: null, more: true };
    }
    const object = await env.MEDIA.head(asset.published.sources[tiers[0]]);
    if (!object) {
      job.status = 'superseded';
      return { job: null, more: true };
    }
  } else {
    const object = await env.MEDIA.head(job.source.key);
    if (!object || object.etag !== job.source.etag) {
      job.status = 'superseded';
      return { job: null, more: true };
    }
  }
  job.status = 'running';
  job.runId = String(data.runId);
  job.lease = { token: crypto.randomUUID(), expiresAt: Date.now() + job.config.media.leaseMs };
  job.updatedAt = new Date().toISOString();
  return {
    job: { ...job, token: job.lease.token },
    ...(isProcessedMode(job) ? { published: asset.published } : {}),
  };
}

/**
 * Retry (re-queue) or cancel a task; revokes the lease so the current runner
 * observes a 409 and moves on.
 * @param {TaskContext & {operation: 'retry'|'cancel'}} context
 * @returns {Promise<{ok:boolean, taskId:string, status:string}>}
 */
export async function settleTask({ state, data, operation, saveManifest }) {
  const job = state.jobs[data.id];
  if (!job) throw Object.assign(new Error('Task not found'), { status: 404 });
  const asset = state.manifest.assets[job.assetId];
  if (asset?.generation !== job.generation || asset.status === 'deleted')
    throw Object.assign(new Error('Task was superseded'), { status: 409 });
  job.status = operation === 'cancel' ? 'cancelled' : 'pending';
  job.lease = null;
  job.attempts = 0;
  job.nextAt = 0;
  asset.status = job.status;
  await saveManifest(state);
  return { ok: true, taskId: job.id, status: job.status };
}

/**
 * Register post-hoc interpolation tasks (`POST /api/media/interpolate`).
 * Every candidate is a video whose published tier MP4s still exist; the job
 * re-encodes them in `processed` mode with the requested interpolation settings
 * and a fresh generation, without downloading originals.
 *
 * @param {TaskContext & {config: object, batchManifest: Function}} context
 * @returns {Promise<{enqueued:number, tasks:Array<{id:string, assetId:string}>, skipped:Array<{assetId:string, reason:string}>}>}
 */
export async function interpolateAssets({ state, data, env, config, saveManifest, batchManifest }) {
  const all = data.all === true;
  const slug = typeof data.slug === 'string' ? data.slug : '';
  const filename = typeof data.filename === 'string' && data.filename ? data.filename : '';
  const jobConfig = data.config || config;
  const baseConfig = data.stateConfig || config;
  const interpolation = jobConfig.videoQuality?.interpolation || {
    ...config.videoQuality.interpolation,
    enabled: true,
  };
  const candidates = Object.values(state.manifest.assets).filter(
    (asset) =>
      asset.status !== 'deleted' &&
      (all || asset.slug === slug) &&
      (filename ? asset.filename === filename : asset.folder === 'videos'),
  );
  const tasks = [];
  const skipped = [];
  await batchManifest(state, async () => {
    for (const asset of candidates) {
      if (asset.folder !== 'videos') {
        skipped.push({ assetId: asset.id, reason: 'not-a-video' });
        continue;
      }
      if (!asset.published?.sources || !Object.keys(asset.published.sources).length) {
        skipped.push({ assetId: asset.id, reason: 'not-decoded' });
        continue;
      }
      const existing = state.jobs[asset.jobId];
      if (
        existing &&
        ['pending', 'running'].includes(existing.status) &&
        existing.options?.sourceMode === 'processed' &&
        existing.options?.interpolation?.fps === interpolation.fps
      ) {
        skipped.push({ assetId: asset.id, reason: 'already-queued' });
        continue;
      }
      const result = await registerAsset({
        state,
        data: {
          id: asset.id,
          slug: asset.slug,
          filename: asset.filename,
          folder: asset.folder,
          order: asset.order,
          source: { ...asset.source, available: asset.source?.available !== false },
          // Input snapshot: the runner re-encodes these exact objects even after a
          // budget-interrupted partial publish replaced asset.published.
          processedSources: { ...asset.published.sources },
          config: jobConfig,
          stateConfig: baseConfig,
          configHash: data.configHash,
          force: true,
          options: { sourceMode: 'processed', interpolation },
        },
        env,
        config: baseConfig,
        saveManifest,
      });
      tasks.push({ id: result.taskId, assetId: asset.id });
    }
    await saveManifest(state);
  });
  return { enqueued: tasks.length, tasks, skipped };
}

/**
 * Runner progress callbacks. Publishes are verified against R2 before the
 * checkpoint becomes visible; keepSource=false final publishes may delete the
 * original (best-effort, never fails the task).
 * @param {TaskContext & {operation: 'heartbeat'|'publish'|'complete'|'failed'}} context
 * @returns {Promise<object>}
 */
export async function recordProgress({ state, data, env, operation, saveManifest }) {
  const job = state.jobs[data.id];
  if (
    !job ||
    job.status !== 'running' ||
    job.lease?.token !== data.token ||
    job.runId !== String(data.runId) ||
    state.manifest.assets[job.assetId]?.generation !== job.generation
  )
    throw Object.assign(new Error('Stale task lease'), { status: 409 });
  const asset = state.manifest.assets[job.assetId];
  job.lease.expiresAt = Date.now() + job.config.media.leaseMs;
  job.updatedAt = new Date().toISOString();
  job.current = data.current || job.current;
  if (operation === 'publish') {
    // Original sources may be gone for post-hoc interpolation or after a
    // keepSource=false release; published tier objects are what the runner
    // re-encoded and are verified below regardless.
    if (!isProcessedMode(job)) {
      const source = await env.MEDIA.head(job.source.key);
      if (source ? source.etag !== job.source.etag : job.source?.available !== false)
        throw Object.assign(new Error('Source changed'), { status: 409 });
    }
    const keys = objectKeys(data.published);
    if (!keys.length || keys.some((key) => !key.startsWith(`processed/${job.slug}/`)))
      throw new Error('Invalid published objects');
    for (const key of keys) if (!(await env.MEDIA.head(key))) throw new Error(`Missing processed object: ${key}`);
    // Sanitized image originals are written conditionally: never overwrite a newer upload.
    if (data.sanitized && data.published.original) {
      const clean = await env.MEDIA.get(data.published.original);
      const written = await env.MEDIA.put(job.source.key, clean.body, {
        onlyIf: { etagMatches: job.source.etag },
        httpMetadata: clean.httpMetadata,
      });
      if (!written) throw Object.assign(new Error('Source changed during privacy processing'), { status: 409 });
      job.source.etag = written.etag;
      asset.source = job.source;
    }
    job.checkpoint = data.published;
    const same = JSON.stringify(asset.published) === JSON.stringify(data.published);
    asset.published = data.published;
    asset.status = data.complete ? 'ready' : 'processing';
    if (!same) await saveManifest(state);
    // Only the final, fully verified publish may release the original source.
    let sourceRetention = null;
    if (data.sourceRetained === false) {
      sourceRetention = await applySourceRetention({ env, job, asset, complete: data.complete === true });
      if (sourceRetention.error) state.lastSourceDeleteError = sourceRetention.error;
    }
    return {
      ok: true,
      revision: state.manifest.revision,
      ...(sourceRetention?.deleted ? { sourceRetained: false } : {}),
    };
  }
  if (operation === 'complete') {
    job.status = data.complete === false ? 'pending' : 'ready';
    job.nextAt = Date.now() + job.config.media.debounceMs;
    job.lease = null;
    asset.status = job.status;
    if (job.status === 'ready' && !asset.published) throw new Error('Cannot complete an unpublished media task');
  }
  if (operation === 'failed') {
    failJob(job, data.error || 'Media processing failed', job.config.media);
    asset.status = job.status;
    await saveManifest(state);
  }
  return { ok: true, revision: state.manifest.revision };
}
