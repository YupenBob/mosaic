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
export async function processTask(job, { request, store, workRoot, now = Date.now, deadline = Infinity }) {
  const directory = fs.mkdtempSync(path.join(workRoot, 'task-'));
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
    await store.download(job.source.key, source, job.source.etag, { signal: controller.signal });
    const hash = await hashFile(source, { signal: controller.signal });
    const prefix = `processed/${job.slug}/${job.folder}/${job.generation}`;
    const publish = async (published, complete, sanitized = false) => {
      if (heartbeatError) throw heartbeatError;
      controller.signal.throwIfAborted();
      await request('media/publish', {
        ...identity,
        published: { ...published, sourceHash: hash },
        complete,
        sanitized,
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
export async function runMedia() {
  const context = loadContext();
  const request = createPipelineClient();
  const store = createStorage(context.config);
  const workRoot = path.resolve(process.env.MEDIA_WORK_DIR || path.join(os.tmpdir(), 'mosaic-media'));
  fs.mkdirSync(workRoot, { recursive: true });
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) throw new Error('GITHUB_RUN_ID is required; production media runs only in Actions');
  const deadline = Date.now() + context.config.media.timeoutMinutes * 60000 * context.config.media.budgetRatio;
  let failures = 0;
  while (Date.now() < deadline) {
    const { job, more } = await request('media/claim', { runId });
    if (!job) {
      if (more) continue;
      break;
    }
    try {
      const complete = await processTask(job, { request, store, workRoot, deadline });
      if (!complete) break;
    } catch (error) {
      console.error(`${job.filename}: ${error.message}`);
      failures++;
    }
  }
  if (failures) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMedia().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
