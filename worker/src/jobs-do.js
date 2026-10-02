/** Durable media outbox, leases, manifests and deployment acknowledgements. */
import { emptyManifest, validateManifest, objectKeys, fingerprint } from '../../shared/media-manifest.mjs';
import { DEFAULTS, processingConfig } from '../../shared/config.mjs';
import { dispatchWorkflow, getWorkflowRun } from './services/workflows.js';

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
      mediaDispatchAt: 0,
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
  async schedule(state, storage = this.storage) {
    const pending = Object.values(state.jobs).some((job) => ['pending', 'running'].includes(job.status));
    if (
      pending ||
      state.buildPending ||
      state.manifestPending ||
      state.reconcile ||
      Object.values(state.builds).some((build) => !build.finishedAt)
    ) {
      const next =
        Date.now() +
        (pending && !Object.values(state.jobs).some((j) => j.status === 'running')
          ? this.config(state).media.debounceMs
          : this.config(state).media.pollMs);
      const old = await storage.getAlarm();
      if (!old || old > next) await storage.setAlarm(next);
    } else await storage.deleteAlarm();
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
  async handle(state, operation, data) {
    if (operation === 'dirty') return this.dirty(state, data.gitSha);
    if (operation === 'dirty-state') return state.dirty;
    if (operation === 'upload-receipt')
      return (
        Object.values(state.jobs).find((job) => job.uploadId === data.uploadId && job.source.key === data.key) || null
      );
    if (operation === 'media-list')
      return Object.values(state.manifest.assets)
        .filter((asset) => asset.slug === data.slug && asset.status !== 'deleted')
        .map(({ id, filename, folder, status, jobId, source, published, order }) => ({
          id,
          filename,
          folder,
          status,
          taskId: jobId,
          order,
          sourceKey: source?.key || '',
          sourceAvailable: source?.available !== false,
          previewKey:
            published?.poster ||
            published?.variants?.['480p'] ||
            Object.values(published?.variants || {})[0] ||
            published?.cover ||
            '',
          published: !!published,
        }));
    if (operation === 'reconcile') {
      state.config = data.config;
      state.reconcile = { after: '', force: data.force || state.reconcile?.force || false };
      return { pending: true, queued: 0 };
    }
    if (operation === 'jobs-list')
      return {
        jobs: Object.values(state.jobs).map(
          ({ config: _config, lease: _lease, checkpoint: _checkpoint, source: _source, ...job }) => job,
        ),
      };
    if (operation === 'job') {
      const job = state.jobs[data.id];
      if (!job) throw Object.assign(new Error('Task not found'), { status: 404 });
      const { config: _config, lease: _lease, ...publicJob } = job;
      return publicJob;
    }
    if (operation === 'build-state')
      return { builds: Object.values(state.builds).map(({ token: _token, ...build }) => build) };
    if (operation === 'state')
      return {
        dirty: state.dirty,
        manifest: state.manifest,
        deployments: state.deployments,
        builds: Object.values(state.builds).map(({ token: _token, ...build }) => build),
        jobs: Object.values(state.jobs).map(({ config: _config, lease: _lease, ...job }) => job),
      };
    if (operation === 'enqueue') {
      // Legacy root covers now upload through photos/: retain their stable identity.
      const legacyCover = state.manifest.assets[`${data.slug}/covers/${data.filename}`];
      if (
        data.folder === 'photos' &&
        legacyCover &&
        legacyCover.status !== 'deleted' &&
        !state.manifest.assets[data.id]
      )
        data = { ...data, id: legacyCover.id, folder: 'covers' };
      state.config = data.config;
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
      await this.saveManifest(state);
      return {
        taskId: id,
        status: 'pending',
        usageDelta: data.source.size - (previous?.source.size || 0),
        objectDelta: previous ? 0 : 1,
      };
    }
    if (operation === 'delete') {
      for (const asset of Object.values(state.manifest.assets)) {
        if (asset.slug !== data.slug || (data.filename && asset.filename !== data.filename)) continue;
        asset.status = 'deleted';
        const job = state.jobs[asset.jobId];
        if (job) {
          job.status = 'cancelled';
          job.lease = null;
        }
      }
      await this.saveManifest(state);
      return { ok: true };
    }
    if (operation === 'import') {
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
      await this.batchManifest(state, async () => {
        for (const [id, asset] of Object.entries(imported.assets)) {
          if (state.manifest.assets[id]) continue;
          state.manifest.assets[id] = asset;
          if (asset.status !== 'ready') await this.handle(state, 'enqueue', { ...asset, config: this.config(state) });
        }
        await this.saveManifest(state);
      });
      return { ok: true, revision: state.manifest.revision };
    }
    if (operation === 'claim') {
      const job = Object.values(state.jobs).find(
        (j) => j.status === 'pending' && (!j.nextAt || j.nextAt <= Date.now()),
      );
      if (!job) return { job: null };
      const asset = state.manifest.assets[job.assetId];
      const object = await this.env.MEDIA.head(job.source.key);
      if (
        !object ||
        object.etag !== job.source.etag ||
        asset?.generation !== job.generation ||
        asset.status === 'deleted'
      ) {
        job.status = 'superseded';
        return { job: null, more: true };
      }
      job.status = 'running';
      job.runId = String(data.runId);
      job.lease = { token: crypto.randomUUID(), expiresAt: Date.now() + job.config.media.leaseMs };
      job.updatedAt = new Date().toISOString();
      return { job: { ...job, token: job.lease.token } };
    }
    if (operation === 'retry' || operation === 'cancel') {
      const job = state.jobs[data.id];
      if (!job) throw Object.assign(new Error('Task not found'), { status: 404 });
      const asset = state.manifest.assets[job.assetId];
      if (asset?.generation !== job.generation || asset.status === 'deleted')
        throw Object.assign(new Error('Task was superseded'), { status: 409 });
      // Revoke this lease; the runner observes 409 and moves to the next task.
      job.status = operation === 'cancel' ? 'cancelled' : 'pending';
      job.lease = null;
      job.attempts = 0;
      job.nextAt = 0;
      asset.status = job.status;
      await this.saveManifest(state);
      return { ok: true, taskId: job.id, status: job.status };
    }
    if (['heartbeat', 'publish', 'complete', 'failed'].includes(operation)) {
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
        const source = await this.env.MEDIA.head(job.source.key);
        if (!source || source.etag !== job.source.etag)
          throw Object.assign(new Error('Source changed'), { status: 409 });
        const keys = objectKeys(data.published);
        if (!keys.length || keys.some((key) => !key.startsWith(`processed/${job.slug}/`)))
          throw new Error('Invalid published objects');
        for (const key of keys)
          if (!(await this.env.MEDIA.head(key))) throw new Error(`Missing processed object: ${key}`);
        // Sanitized image originals are written conditionally: never overwrite a newer upload.
        if (data.sanitized && data.published.original) {
          const clean = await this.env.MEDIA.get(data.published.original);
          const written = await this.env.MEDIA.put(job.source.key, clean.body, {
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
        if (!same) await this.saveManifest(state);
      }
      if (operation === 'complete') {
        job.status = data.complete === false ? 'pending' : 'ready';
        job.nextAt = Date.now() + job.config.media.debounceMs;
        job.lease = null;
        asset.status = job.status;
        if (job.status === 'ready' && !asset.published) throw new Error('Cannot complete an unpublished media task');
      }
      if (operation === 'failed') {
        this.fail(job, data.error || 'Media processing failed');
        asset.status = job.status;
        await this.saveManifest(state);
      }
      return { ok: true, revision: state.manifest.revision };
    }
    if (operation === 'build-begin') {
      if (this.env.REQUIRE_MEDIA_MIGRATION === 'true' && !state.initialized) {
        if (!(await this.env.MEDIA.head('site-data/media-migration-v1.json')))
          throw Object.assign(new Error('Run Mosaic Media migration before the first site deployment'), {
            status: 503,
          });
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
    if (operation === 'build-progress' || operation === 'build-done') {
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
    throw Object.assign(new Error('Unknown coordinator operation'), { status: 404 });
  }
  fail(job, error) {
    job.attempts++;
    job.error = String(error);
    job.lease = null;
    job.status = job.attempts <= job.config.media.maxRetries ? 'pending' : 'failed';
    job.nextAt = Date.now() + job.config.media.retryMs * Math.max(1, job.attempts);
  }
  alarm() {
    const result = this.queue
      .then(async () => {
        const state = await this.load();
        let expired = false;
        for (const job of Object.values(state.jobs))
          if (job.status === 'running' && job.lease.expiresAt <= Date.now()) {
            this.fail(job, 'Task lease expired (cancelled or interrupted runner)');
            state.manifest.assets[job.assetId].status = job.status;
            expired = true;
          }
        if (expired) await this.saveManifest(state);
        const config = this.config(state);
        if (state.reconcile) {
          try {
            const ids = Object.keys(state.manifest.assets)
              .sort()
              .filter((id) => id > state.reconcile.after)
              .slice(0, config.media.reconcileBatchSize);
            await this.batchManifest(state, async () => {
              for (const id of ids) {
                const asset = state.manifest.assets[id];
                if (asset.status !== 'deleted' && asset.source.available !== false) {
                  const source = await this.env.MEDIA.head(asset.source.key);
                  if (source)
                    await this.handle(state, 'enqueue', {
                      ...asset,
                      source: { ...asset.source, etag: source.etag, size: source.size },
                      config,
                      force: state.reconcile.force,
                      configHash: await fingerprint(processingConfig(config, asset.folder)),
                    });
                }
                state.reconcile.after = id;
              }
              if (ids.length < config.media.reconcileBatchSize) state.reconcile = null;
            });
          } catch (error) {
            state.lastDispatchError = `Media reconciliation: ${error.message}`;
          }
        }
        const pending = Object.values(state.jobs).some(
          (job) => job.status === 'pending' && (!job.nextAt || job.nextAt <= Date.now()),
        );
        const running = Object.values(state.jobs).some((job) => job.status === 'running');
        try {
          if (state.manifestPending) await this.flushManifest(state);
          if (pending && !running && Date.now() - state.mediaDispatchAt >= config.media.leaseMs) {
            await dispatchWorkflow({ env: this.env }, 'media', {}, config);
            state.mediaDispatchAt = Date.now();
          }
          if (state.buildPending) {
            // A workflow dispatch outbox stays pending on network/auth failures.
            await dispatchWorkflow({ env: this.env }, 'site', {}, config);
            state.buildPending = false;
          }
          for (const snapshot of Object.values(state.builds))
            if (!snapshot.finishedAt && Date.now() - Date.parse(snapshot.startedAt) > config.media.leaseMs) {
              const run = await getWorkflowRun({ env: this.env }, snapshot.runId);
              if (run?.status === 'completed') {
                snapshot.finishedAt = new Date().toISOString();
                snapshot.success = false;
                snapshot.callbackMissing = true;
              }
            }
        } catch (error) {
          state.lastDispatchError = error.message;
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
}
