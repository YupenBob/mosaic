/**
 * Pure helpers for the durable media-task queue: due/active detection, lease
 * expiry, retry bookkeeping and alarm wake-up calculation. All functions are
 * pure or mutate only the passed state object, so `tests/jobs-smoke.mjs` and
 * `tests/media-options-smoke.mjs` can exercise them without Workers.
 */
import { DEFAULTS } from '../../../shared/config.mjs';

/** Tasks that count as outstanding work, regardless of their next attempt. */
export const ACTIVE_JOB_STATUSES = ['pending', 'running'];

/**
 * @param {object} job
 * @param {number} now
 * @returns {boolean} pending and due for a runner
 */
export function isJobDue(job, now = Date.now()) {
  return job.status === 'pending' && (!job.nextAt || job.nextAt <= now);
}

/**
 * @param {{jobs: Record<string, object>}} state
 * @param {number} [now]
 * @returns {object[]}
 */
export function dueJobs(state, now = Date.now()) {
  return Object.values(state.jobs).filter((job) => isJobDue(job, now));
}

/**
 * @param {{jobs: Record<string, object>}} state
 * @returns {boolean}
 */
export function hasRunningJobs(state) {
  return Object.values(state.jobs).some((job) => job.status === 'running');
}

/**
 * @param {{jobs: Record<string, object>}} state
 * @returns {boolean}
 */
export function hasOutstandingJobs(state) {
  return Object.values(state.jobs).some((job) => ACTIVE_JOB_STATUSES.includes(job.status));
}

/**
 * Record a failed attempt: bounded exponential retry, then terminal `failed`.
 * @param {object} job
 * @param {string} error
 * @param {{maxRetries:number, retryMs:number}} [mediaConfig]
 * @param {number} [now]
 * @returns {string} the new job status
 */
export function failJob(job, error, mediaConfig = DEFAULTS.media, now = Date.now()) {
  job.attempts = (job.attempts || 0) + 1;
  job.error = String(error);
  job.lease = null;
  job.status = job.attempts <= mediaConfig.maxRetries ? 'pending' : 'failed';
  job.nextAt = now + mediaConfig.retryMs * Math.max(1, job.attempts);
  return job.status;
}

/**
 * Release leases whose runner disappeared (crash, cancellation, evicted
 * isolate) so the task becomes claimable again.
 * @param {object} state
 * @param {number} [now]
 * @param {object} [mediaConfig]
 * @returns {boolean} true when any lease expired (manifest needs saving)
 */
export function expireLeases(state, now = Date.now(), mediaConfig = DEFAULTS.media) {
  let expired = false;
  for (const job of Object.values(state.jobs))
    if (job.status === 'running' && job.lease && job.lease.expiresAt <= now) {
      failJob(job, 'Task lease expired (cancelled or interrupted runner)', mediaConfig, now);
      const asset = state.manifest.assets[job.assetId];
      if (asset) asset.status = job.status;
      expired = true;
    }
  return expired;
}

/**
 * Earliest alarm time required by queued/running tasks. Returns 0 when there is
 * no task work left.
 * @param {{jobs: Record<string, object>}} state
 * @param {object} config
 * @param {number} [now]
 * @returns {number}
 */
export function nextTaskWakeAt(state, config, now = Date.now()) {
  const times = [];
  if (hasRunningJobs(state)) times.push(now + config.media.pollMs);
  for (const job of Object.values(state.jobs)) {
    if (job.status !== 'pending') continue;
    times.push(job.nextAt && job.nextAt > now ? job.nextAt : now + config.media.debounceMs);
  }
  return times.length ? Math.min(...times) : 0;
}

/**
 * @param {{builds?: Record<string, object>}} state
 * @returns {boolean}
 */
export function hasUnfinishedBuilds(state) {
  return Object.values(state.builds || {}).some((build) => !build.finishedAt);
}
