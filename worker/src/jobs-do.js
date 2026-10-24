/**
 * Jobs Durable Object: serialized owner of the media task queue, published
 * manifest, dirty/deployment state and the alarm-driven dispatch outbox.
 *
 * The heavy lifting lives in focused modules under `worker/src/jobs/`:
 * - `job-state.mjs`       due/lease/retry bookkeeping and alarm wake-up math
 * - `media-task-ops.mjs`  enqueue/claim/progress/publish/complete lifecycle
 * - `media-options.mjs`   per-task option normalization + admin projections
 * - `source-retention.mjs` keepSource deletion of `originals/...`
 * - `media-dispatch.mjs`  persisted `workflow_dispatch` state machine
 * - `reconcile.mjs`       durable configuration reconciliation batches
 */
import { emptyManifest, validateManifest } from '../../shared/media-manifest.mjs';
import { DEFAULTS } from '../../shared/config.mjs';
import { dispatchWorkflow, getWorkflowRun, findActiveWorkflowRun } from './services/workflows.js';
import { hasRunningJobs, hasUnfinishedBuilds, expireLeases, isJobDue, nextTaskWakeAt } from './jobs/job-state.mjs';
import {
  createMediaDispatch,
  driveMediaDispatch,
  mediaDispatchWakeAt,
  normalizeMediaDispatch,
} from './jobs/media-dispatch.mjs';
import { publicJobView } from './jobs/media-options.mjs';
import {
  claimTask,
  importAssets,
  interpolateAssets,
  recordProgress,
  registerAsset,
  removeAssets,
  settleTask,
} from './jobs/media-task-ops.mjs';
import { reconcileBatch } from './jobs/reconcile.mjs';

export class JobsDurableObject {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.queue = Promise.resolve();
    this.persisted = new Map();
    this.state = null;
  }
  fetch(request) {
    const operation = new URL(request.url).pathname.slice(1);
    const result = this.queue
      .then(async () => {
        const data = await request.json();
        const state = await this.load();
        const output = await this.handle(state, operation, data);
        await this.persist(state);
        return Response.json(output);
      })
      .catch((error) => {
        this.state = null;
        return Response.json({ error: error.message }, { status: error.status || 500 });
      });
    this.queue = result.then(() => {});
    return result;
  }
  async load() {
    if (this.state) return this.state;
    const saved = await this.storage.get('state');
    if (saved?.sharded) {
      const [assets, jobs, builds] = await Promise.all(
        ['assets:', 'jobs:', 'builds:'].map((prefix) => this.readRows(prefix)),
      );
      return (this.state = { ...saved, manifest: { ...saved.manifest, assets }, jobs, builds });
    }
    if (saved) return (this.state = saved);
    const object = await this.env.MEDIA.get(this.env.MEDIA_MANIFEST_KEY || DEFAULTS.media.manifestKey);
    const manifest = object ? validateManifest(JSON.parse(await object.text())) : emptyManifest();
    return (this.state = {
      manifest,
      jobs: {},
      dirty: { revision: 0, count: 0 },
      builds: {},
      deployments: [],
      buildPending: false,
      config: null,
      mediaDispatch: createMediaDispatch(),
    });
  }
  async readRows(prefix) {
    const values = {};
    let startAfter;
    do {
      const rows = await this.storage.list({ prefix, limit: 1000, ...(startAfter ? { startAfter } : {}) });
      for (const [key, value] of rows) {
        values[key.slice(prefix.length)] = value;
        this.persisted.set(key, JSON.stringify(value));
      }
      startAfter = rows.size === 1000 ? [...rows.keys()].at(-1) : null;
    } while (startAfter);
    return values;
  }
  async persist(state) {
    const { jobs, builds, manifest, ...metadata } = state;
    const values = { state: { ...metadata, sharded: true, manifest: { ...manifest, assets: {} } } };
    for (const [prefix, rows] of [
      ['assets:', manifest.assets],
      ['jobs:', jobs],
      ['builds:', builds],
    ])
      for (const [id, value] of Object.entries(rows)) values[prefix + id] = value;
    const changed = Object.entries(values).filter(([key, value]) => this.persisted.get(key) !== JSON.stringify(value));
    const write = async (storage) => {
      for (let offset = 0; offset < changed.length; offset += 128)
        await storage.put(Object.fromEntries(changed.slice(offset, offset + 128)));
      await this.schedule(state, storage);
    };
    // One atomic transaction, many bounded records: no growing monolithic KV value.
    if (this.storage.transaction) await this.storage.transaction(write);
    else await write(this.storage);
    for (const [key, value] of changed) this.persisted.set(key, JSON.stringify(value));
  }
  config(state) {
    return state.config || DEFAULTS;
  }
  /**
   * Alarm scheduling is derived from every wake-up source, so a dispatch retry,
   * a future task retry, a manifest outbox or a build check can never be
   * silently forgotten after enqueue/reconcile/retry/budget-exit.
   */
  async schedule(state, storage = this.storage) {
    const config = this.config(state);
    const now = Date.now();
    const dispatch = normalizeMediaDispatch(state.mediaDispatch, state);
    const outstanding = Object.values(state.jobs).some((job) => ['pending', 'running'].includes(job.status));
    const buildsActive = hasUnfinishedBuilds(state);
    const dispatchActive = dispatch.status !== 'idle';
    if (
      !outstanding &&
      !state.buildPending &&
      !state.manifestPending &&
      !state.reconcile &&
      !buildsActive &&
      !dispatchActive
    ) {
      await storage.deleteAlarm();
      return;
    }
    const wakes = [];
    const taskWake = nextTaskWakeAt(state, config, now);
    if (taskWake) wakes.push(taskWake);
    const dispatchWake = mediaDispatchWakeAt(dispatch, config, now);
    if (dispatchWake) wakes.push(dispatchWake);
    if (state.buildPending || state.manifestPending || state.reconcile || buildsActive)
      wakes.push(now + config.media.pollMs);
    const next = Math.min(...wakes);
    const old = await storage.getAlarm();
    if (!old || old > next) await storage.setAlarm(next);
  }
  async saveManifest(state) {
    if (this.batching) {
      this.batchChanged = true;
      return;
    }
    state.manifest.revision++;
    state.manifestPending = true;
    state.buildPending = true;
    this.dirty(state, '', false);
    // Persist the outbox before R2 I/O: an upload remains registered if R2 is unavailable.
    await this.persist(state);
    try {
      await this.flushManifest(state);
    } catch (error) {
      state.lastDispatchError = `Manifest publication: ${error.message}`;
    }
  }
  async batchManifest(state, work) {
    this.batching = true;
    this.batchChanged = false;
    try {
      return await work();
    } finally {
      this.batching = false;
      if (this.batchChanged) await this.saveManifest(state);
      this.batchChanged = false;
    }
  }
  async flushManifest(state) {
    const body = JSON.stringify(state.manifest);
    const options = { httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } };
    await this.env.MEDIA.put(`site-data/media-manifests/${state.manifest.revision}.json`, body, options);
    await this.env.MEDIA.put(this.config(state).media.manifestKey, body, options);
    state.manifestPending = false;
  }
  dirty(state, gitSha = '', content = true) {
    const revision = state.dirty.revision + 1;
    state.dirty = {
      revision,
      count: state.dirty.count + 1,
      last: new Date().toISOString(),
      gitSha: gitSha || state.dirty.gitSha || '',
      contentDirty: content || !!state.dirty.contentDirty,
      contentRevision: content ? revision : state.dirty.contentRevision || 0,
    };
    return state.dirty;
  }
  /** @param {object} state @param {object} data */
  context(state, data) {
    return {
      state,
      data,
      env: this.env,
      config: this.config(state),
      saveManifest: (target) => this.saveManifest(target),
      batchManifest: (target, work) => this.batchManifest(target, work),
    };
  }
  mediaList(state, data) {
    return Object.values(state.manifest.assets)
      .filter((asset) => asset.slug === data.slug && asset.status !== 'deleted')
      .map(({ id, filename, folder, status, jobId, source, published, order, sourceDeletedAt }) => {
        const job = state.jobs[jobId];
        return {
          id,
          filename,
          folder,
          status,
          taskId: jobId,
          order,
          sourceKey: source?.key || '',
          sourceAvailable: source?.available !== false,
          sourceDeletedAt: sourceDeletedAt || source?.deletedAt || null,
          options: job?.options || {},
          previewKey:
            published?.poster ||
            published?.variants?.['480p'] ||
            Object.values(published?.variants || {})[0] ||
            published?.cover ||
            '',
          published: !!published,
        };
      });
  }
  async handle(state, operation, data) {
    if (operation === 'dirty') return this.dirty(state, data.gitSha);
    if (operation === 'dirty-state') return state.dirty;
    if (operation === 'upload-receipt')
      return (
        Object.values(state.jobs).find((job) => job.uploadId === data.uploadId && job.source.key === data.key) || null
      );
    if (operation === 'media-list') return this.mediaList(state, data);
    if (operation === 'reconcile') {
      state.config = data.config;
      state.reconcile = { after: '', force: data.force || state.reconcile?.force || false };
      return { pending: true, queued: 0 };
    }
    if (operation === 'jobs-list')
      return {
        jobs: Object.values(state.jobs).map((job) => publicJobView(job, state.manifest.assets[job.assetId])),
        mediaDispatch: normalizeMediaDispatch(state.mediaDispatch, state),
      };
    if (operation === 'job') {
      const job = state.jobs[data.id];
      if (!job) throw Object.assign(new Error('Task not found'), { status: 404 });
      return publicJobView(job, state.manifest.assets[job.assetId]);
    }
    if (operation === 'build-state')
      return { builds: Object.values(state.builds).map(({ token: _token, ...build }) => build) };
    if (operation === 'state')
      return {
        dirty: state.dirty,
        manifest: state.manifest,
        deployments: state.deployments,
        mediaDispatch: normalizeMediaDispatch(state.mediaDispatch, state),
        builds: Object.values(state.builds).map(({ token: _token, ...build }) => build),
        jobs: Object.values(state.jobs).map(({ config: _config, lease: _lease, ...job }) => job),
      };
    if (operation === 'enqueue') return registerAsset(this.context(state, data));
    if (operation === 'delete') return removeAssets(this.context(state, data));
    if (operation === 'import') return importAssets(this.context(state, data));
    if (operation === 'interpolate') return interpolateAssets(this.context(state, data));
    if (operation === 'claim') return claimTask(this.context(state, data));
    if (operation === 'retry' || operation === 'cancel') return settleTask({ ...this.context(state, data), operation });
    if (['heartbeat', 'publish', 'complete', 'failed'].includes(operation))
      return recordProgress({ ...this.context(state, data), operation });
    if (operation === 'build-begin') return this.buildBegin(state, data);
    if (operation === 'build-progress' || operation === 'build-done') return this.buildProgress(state, operation, data);
    throw Object.assign(new Error('Unknown coordinator operation'), { status: 404 });
  }
  async buildBegin(state, data) {
    if (this.env.REQUIRE_MEDIA_MIGRATION === 'true' && !state.initialized) {
      if (!(await this.env.MEDIA.head('site-data/media-migration-v1.json')))
        throw Object.assign(new Error('Run Mosaic Media migration before the first site deployment'), { status: 503 });
      state.initialized = true;
    }
    await this.flushManifest(state);
    const runId = String(data.runId);
    const prior = state.builds[runId];
    if (prior) {
      const object = await this.env.MEDIA.get(`site-data/media-manifests/${prior.mediaRevision}.json`);
      if (!object) throw new Error('Build manifest snapshot is missing');
      return { ...prior, manifest: JSON.parse(await object.text()) };
    }
    const snapshot = {
      runId,
      token: crypto.randomUUID(),
      gitSha: data.gitSha,
      mediaRevision: state.manifest.revision,
      dirtyRevision: data.coversContent === false ? -1 : state.dirty.revision,
      contentRevision: state.dirty.contentRevision || 0,
      coversContent: data.coversContent !== false,
      stage: 'generate',
      startedAt: new Date().toISOString(),
    };
    state.builds[runId] = snapshot;
    return { ...snapshot, manifest: state.manifest };
  }
  async buildProgress(state, operation, data) {
    const snapshot = state.builds[String(data.runId)];
    if (!snapshot || snapshot.token !== data.token)
      throw Object.assign(new Error('Unknown build lease'), { status: 409 });
    if (operation === 'build-progress') {
      snapshot.stage = data.stage;
      snapshot.updatedAt = new Date().toISOString();
      return { ok: true };
    }
    if (snapshot.finishedAt && !snapshot.callbackMissing) return { ok: true, duplicate: true };
    snapshot.callbackMissing = false;
    snapshot.finishedAt = new Date().toISOString();
    snapshot.success = data.success === true;
    snapshot.cachePublished = data.cachePublished !== false;
    if (snapshot.success) {
      if (
        snapshot.cachePublished &&
        snapshot.coversContent &&
        snapshot.contentRevision === (state.dirty.contentRevision || 0)
      )
        state.dirty.contentDirty = false;
      state.deployments.unshift({ ...snapshot, token: undefined });
      state.deployments = state.deployments.slice(0, this.config(state).media.deploymentHistory);
      if (snapshot.dirtyRevision === state.dirty.revision && snapshot.mediaRevision === state.manifest.revision)
        state.dirty.count = 0;
      else state.buildPending = true;
    }
    return { ok: true, dirty: state.dirty.count > 0 };
  }
  alarm() {
    const result = this.queue
      .then(async () => {
        const state = await this.load();
        const config = this.config(state);
        const now = Date.now();
        // 1. Release interrupted runners' leases (bounded retry).
        if (expireLeases(state, now, config.media)) await this.saveManifest(state);
        // 2. Durable configuration reconciliation batches.
        if (state.reconcile) await reconcileBatch(this.context(state, {}));
        // 3. Manifest outbox: retried every alarm until R2 accepts it.
        try {
          if (state.manifestPending) await this.flushManifest(state);
        } catch (error) {
          state.lastDispatchError = `Manifest publication: ${error.message}`;
        }
        // 4. Media workflow dispatch state machine (never blocks site builds).
        try {
          const dispatch = await driveMediaDispatch({
            state,
            config,
            now,
            queue: { pending: this.hasDueWork(state, now), running: hasRunningJobs(state) },
            io: {
              dispatchMedia: () => dispatchWorkflow({ env: this.env }, 'media', {}, config),
              findActiveRun: () => findActiveWorkflowRun({ env: this.env }, 'media', config),
              getRun: (id) => getWorkflowRun({ env: this.env }, id),
            },
          });
          if (dispatch.error) state.lastDispatchError = `Media dispatch: ${dispatch.error}`;
        } catch (error) {
          state.lastDispatchError = `Media dispatch: ${error.message}`;
        }
        // 5. Site build dispatch: independent retry/outbox.
        try {
          if (state.buildPending) {
            await dispatchWorkflow({ env: this.env }, 'site', {}, config);
            state.buildPending = false;
          }
        } catch (error) {
          state.lastBuildDispatchError = error.message;
        }
        // 6. Recover deployments whose callback never arrived (GitHub run done).
        for (const snapshot of Object.values(state.builds))
          if (!snapshot.finishedAt && Date.now() - Date.parse(snapshot.startedAt) > config.media.leaseMs) {
            try {
              const run = await getWorkflowRun({ env: this.env }, snapshot.runId);
              if (run?.status === 'completed') {
                snapshot.finishedAt = new Date().toISOString();
                snapshot.success = false;
                snapshot.callbackMissing = true;
              }
            } catch (error) {
              state.lastBuildDispatchError = error.message;
            }
          }
        await this.persist(state);
      })
      .catch(async (error) => {
        this.state = null;
        await this.storage.setAlarm(Date.now() + DEFAULTS.media.retryMs);
        throw error;
      });
    this.queue = result.catch(() => {});
    return result;
  }
  /** @param {object} state @param {number} now */
  hasDueWork(state, now) {
    return Object.values(state.jobs).some((job) => isJobDue(job, now));
  }
}
