import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../lib/context.mjs';
import { createPipelineClient } from '../lib/pipeline-client.mjs';
import { createStorage } from './storage.mjs';
import { processImage } from './images.mjs';
import { processVideo } from './videos.mjs';
import { processAudio } from './audio.mjs';
import { hashFile } from './process.mjs';

/** R2 prefix for a task's generated objects: legacy slug or independent asset. */
export function processedPrefixFor(job) {
  return job.v2
    ? `processed/assets/${job.assetId}/${job.generation}`
    : `processed/${job.slug}/${job.folder}/${job.generation}`;
}

export async function processTask(
  job,
  { request, store, workRoot, now = Date.now, deadline = Infinity, published = null },
) {
  const directory = fs.mkdtempSync(path.join(workRoot, 'task-'));
  const processedMode = job.options?.sourceMode === 'processed';
  const source = path.join(directory, `source.${job.filename.split('.').pop()}`);
  const identity = { id: job.id, token: job.token, runId: job.runId };
  const started = now();
  const controller = new AbortController();
  const budgetError = Object.assign(new Error('Media processing budget reached'), { code: 'MEDIA_BUDGET' });
  const budgetMs = Math.min(deadline - started, job.config.media.timeoutMinutes * 60000 * job.config.media.budgetRatio);
  const budgetTimer = setTimeout(() => controller.abort(budgetError), Math.max(0, budgetMs));
  if (budgetMs <= 0) controller.abort(budgetError);
  let heartbeatError;
  const heartbeat = setInterval(
    () =>
      request('media/heartbeat', { ...identity, current: job.filename }).catch((error) => {
        heartbeatError = error;
        if (error.status === 409) controller.abort();
      }),
    Math.max(1000, job.config.media.leaseMs / 3),
  );
  try {
    controller.signal.throwIfAborted();
    // Processed-mode jobs re-encode already published tiers; originals may be gone.
    let hash = job.source?.etag || '';
    if (!processedMode) {
      await store.download(job.source.key, source, job.source.etag, { signal: controller.signal });
      hash = await hashFile(source, { signal: controller.signal });
    } else if (!published?.sources || !Object.keys(published.sources).length) {
      throw new Error('Processed source has no published tiers to re-encode');
    }
    const prefix = processedPrefixFor(job);
    const publish = async (payload, complete, sanitized = false, extra = {}) => {
      if (heartbeatError) throw heartbeatError;
      // A budget abort must still allow a safe-point partial publish (the
      // processor verifies every referenced object before handing it over).
      if (controller.signal.aborted && controller.signal.reason?.code !== 'MEDIA_BUDGET')
        controller.signal.throwIfAborted();
      await request('media/publish', {
        ...identity,
        published: { ...payload, sourceHash: hash },
        complete,
        sanitized,
        ...extra,
      });
    };
    const budgetExceeded = () =>
      now() >= deadline || now() - started >= job.config.media.timeoutMinutes * 60000 * job.config.media.budgetRatio;
    const processor = job.folder === 'videos' ? processVideo : job.folder === 'music' ? processAudio : processImage;
    const complete = await processor({
      source,
      directory,
      job,
      store,
      prefix,
      publish,
      budgetExceeded,
      signal: controller.signal,
      published,
    });
    await request('media/complete', { ...identity, complete });
    return complete;
  } catch (error) {
    if (heartbeatError?.status === 409) throw heartbeatError;
    if (controller.signal.reason?.code === 'MEDIA_BUDGET') {
      await request('media/complete', { ...identity, complete: false });
      return false;
    }
    if (error.status !== 409) await request('media/failed', { ...identity, error: error.message });
    throw error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(budgetTimer);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
/**
 * Claim and process media tasks until the queue drains or the run budget ends.
 *
 * Claims are bounded by `upload.concurrency`; images and audio run in parallel
 * while video jobs pass through a single serial lane (one ffmpeg transcode at
 * a time) and heartbeat their lease while queued.
 *
 * @param {{context?: object, request?: Function, store?: object, runId?: string}} [deps]
 *   Dependency seam used by tests; production calls it with no arguments.
 */
export async function runMedia(deps = {}) {
  const context = deps.context || loadContext();
  const request = deps.request || createPipelineClient();
  const store = deps.store || createStorage(context.config);
  const workRoot = path.resolve(process.env.MEDIA_WORK_DIR || path.join(os.tmpdir(), 'mosaic-media'));
  fs.mkdirSync(workRoot, { recursive: true });
  const runId = deps.runId || process.env.GITHUB_RUN_ID;
  if (!runId) throw new Error('GITHUB_RUN_ID is required; production media runs only in Actions');
  const deadline = Date.now() + context.config.media.timeoutMinutes * 60000 * context.config.media.budgetRatio;
  // Images and audio run side by side; ffmpeg-heavy video jobs stay serial so
  // two transcodes never contend for the same CPU inside one runner.
  const concurrency = Math.max(1, Number(context.config.upload?.concurrency) || 1);
  let failures = 0;
  let stopping = false;
  const active = new Set();
  let videoChain = Promise.resolve();
  const runVideoSerially = (work) => {
    const next = videoChain.then(work, work);
    videoChain = next.catch(() => {});
    return next;
  };
  const dispatch = (job, published) => {
    const work = async () => {
      try {
        const complete = await processTask(job, { request, store, workRoot, deadline, published });
        // A budget stop requeues the remaining work; stop claiming new jobs.
        if (!complete) stopping = true;
      } catch (error) {
        console.error(`${job.filename}: ${error.message}`);
        failures++;
      }
    };
    let task;
    if (job.folder === 'videos') {
      // The video lane is serial, so a claimed video may wait for the previous
      // transcode (up to the timeout). Keep its 120s lease alive while queued;
      // processTask starts its own heartbeat once the lane reaches this job.
      let queued = true;
      const leaseTimer = setInterval(
        () => {
          if (!queued) return;
          request('media/heartbeat', {
            id: job.id,
            token: job.token,
            runId: job.runId,
            current: job.filename,
          }).catch((error) => {
            // The lease was revoked/superseded; the task itself will observe 409.
            if (error.status === 409) queued = false;
          });
        },
        Math.max(1000, Math.floor(job.config.media.leaseMs / 3)),
      );
      task = runVideoSerially(async () => {
        queued = false;
        clearInterval(leaseTimer);
        return work();
      }).finally(() => {
        queued = false;
        clearInterval(leaseTimer);
      });
    } else {
      task = work();
    }
    const tracked = Promise.resolve(task).finally(() => active.delete(tracked));
    active.add(tracked);
  };
  while (!stopping && Date.now() < deadline) {
    if (active.size >= concurrency) {
      await Promise.race(active);
      continue;
    }
    let claim;
    try {
      claim = await request('media/claim', { runId });
    } catch (error) {
      console.error(`media/claim: ${error.message}`);
      failures++;
      break;
    }
    const { job, published, more } = claim;
    if (!job) {
      if (more) continue;
      break;
    }
    dispatch(job, published);
  }
  await Promise.allSettled([...active]);
  if (failures) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMedia().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
