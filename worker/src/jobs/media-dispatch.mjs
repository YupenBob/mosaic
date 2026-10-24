/**
 * Persisted media-workflow dispatch state machine.
 *
 * Root cause this fixes: the previous coordinator only throttled
 * `workflow_dispatch` by a timestamp, never verifying whether a media run was
 * already queued/running. During GitHub Actions queue latency it re-dispatched
 * every `leaseMs` (duplicates that can cancel the pending run under the
 * workflow concurrency group), and a dispatch that succeeded just before an
 * isolate eviction was indistinguishable from one that never happened.
 *
 * The state machine persists a single record on the coordinator:
 * `{status, runId, dispatches, dispatchedAt, checkAt, attempt, misses, nextAt,
 * lastError, lastErrorAt}` in `idle | dispatching | active | retry` and drives
 * every decision from it:
 * - never dispatch while a running task lease exists (a runner is working),
 * - `dispatching`/`active` runs are verified (by run id, else by the workflow
 *   run list filtered to workflow_dispatch on the deploy branch) after
 *   `leaseMs`; only when no active/queued run exists is another dispatch made,
 * - dispatch failures retry with exponential backoff instead of every alarm,
 * - a runner that disappears with pending work (budget exit/crash) is detected
 *   by verify -> completed/absent run -> re-dispatch.
 */
import { DEFAULTS } from '../../../shared/config.mjs';

/** GitHub run statuses that mean "a media run exists or will start soon". */
export const ACTIVE_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
export const DISPATCH_STATUSES = ['idle', 'dispatching', 'active', 'retry'];
const MAX_BACKOFF_MS = 15 * 60 * 1000;

/**
 * @typedef {object} MediaDispatchState
 * @property {'idle'|'dispatching'|'active'|'retry'} status
 * @property {string} runId - best-known GitHub run id (empty until observed)
 * @property {number} dispatches - successful dispatch requests (lifetime)
 * @property {number} dispatchedAt - timestamp of the last successful dispatch
 * @property {number} checkAt - when an in-flight/active dispatch must be verified
 * @property {number} attempt - consecutive dispatch failures
 * @property {number} misses - verified runs that ended while work was pending
 * @property {number} nextAt - retry/backoff deadline
 * @property {string} lastError
 * @property {number} lastErrorAt
 */

/**
 * @returns {MediaDispatchState}
 */
export function createMediaDispatch() {
  return {
    status: 'idle',
    runId: '',
    dispatches: 0,
    dispatchedAt: 0,
    checkAt: 0,
    attempt: 0,
    misses: 0,
    nextAt: 0,
    lastError: '',
    lastErrorAt: 0,
  };
}

/**
 * Normalize a persisted dispatch record (including state written by the
 * timestamp-only coordinator before this upgrade).
 * @param {unknown} value
 * @param {object} [legacyState] - previous `state` object carrying `mediaDispatchAt`
 * @returns {MediaDispatchState}
 */
export function normalizeMediaDispatch(value, legacyState = {}) {
  const base = createMediaDispatch();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const dispatch = { ...base, ...source };
  if (!DISPATCH_STATUSES.includes(dispatch.status)) dispatch.status = 'idle';
  for (const key of ['runId', 'lastError']) if (typeof dispatch[key] !== 'string') dispatch[key] = '';
  for (const key of ['dispatches', 'dispatchedAt', 'checkAt', 'attempt', 'misses', 'nextAt', 'lastErrorAt'])
    if (!Number.isFinite(dispatch[key]) || dispatch[key] < 0) dispatch[key] = 0;
  // Rolling upgrade: a legacy timestamp means "a dispatch happened recently".
  if (dispatch.status === 'idle' && !dispatch.dispatchedAt && Number(legacyState.mediaDispatchAt) > 0) {
    dispatch.dispatchedAt = Number(legacyState.mediaDispatchAt);
    dispatch.status = Date.now() - dispatch.dispatchedAt < DEFAULTS.media.leaseMs ? 'dispatching' : 'idle';
    dispatch.checkAt = dispatch.dispatchedAt + DEFAULTS.media.leaseMs;
  }
  return dispatch;
}

/**
 * Exponential dispatch retry delay (base `media.retryMs`, capped at 15 min).
 * @param {number} attempt - consecutive failure number (1-based)
 * @param {object} [config]
 * @returns {number} milliseconds
 */
export function dispatchBackoffMs(attempt, config = DEFAULTS) {
  const base = Math.max(1, Number(config?.media?.retryMs) || DEFAULTS.media.retryMs);
  return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.max(0, attempt - 1));
}

/**
 * Decide the next dispatch action from persisted state plus queue facts.
 * @param {object} options
 * @param {MediaDispatchState|undefined} options.dispatch
 * @param {boolean} options.pending - at least one due pending task
 * @param {boolean} options.running - a runner currently holds a task lease
 * @param {number} [options.now]
 * @param {object} [options.config]
 * @returns {{action:'idle'|'wait'|'verify'|'dispatch', checkAt?:number}}
 */
export function planMediaDispatch({ dispatch, pending, running, now = Date.now(), config = DEFAULTS }) {
  const state = normalizeMediaDispatch(dispatch);
  if (!pending && !running) return { action: 'idle' };
  if (running) return { action: 'wait', checkAt: now + config.media.pollMs };
  if (state.status === 'active' || state.status === 'dispatching') {
    if (now < state.checkAt) return { action: 'wait', checkAt: state.checkAt };
    return { action: 'verify' };
  }
  if (state.status === 'retry') {
    if (now < state.nextAt) return { action: 'wait', checkAt: state.nextAt };
    return { action: 'verify' };
  }
  // Idle with pending work: confirm no orphaned/queued run before dispatching.
  return { action: 'verify' };
}

/**
 * Earliest alarm time needed by dispatch bookkeeping (0 when idle).
 * @param {MediaDispatchState|undefined} dispatch
 * @param {object} [config]
 * @param {number} [now]
 * @returns {number}
 */
export function mediaDispatchWakeAt(dispatch, config = DEFAULTS, now = Date.now()) {
  const state = normalizeMediaDispatch(dispatch);
  if (state.status === 'retry') return state.nextAt || now + config.media.retryMs;
  if (state.status === 'active' || state.status === 'dispatching') return state.checkAt || now + config.media.leaseMs;
  return 0;
}

/**
 * Observe the run we last dispatched: prefer the concrete run id, fall back to
 * the workflow's active/queued run list.
 * @param {object} io
 * @param {MediaDispatchState} dispatch
 * @returns {Promise<object|null>} active run (with numeric `id`) or null
 */
async function observeActiveRun(io, dispatch) {
  if (dispatch.runId && io.getRun) {
    try {
      const run = await io.getRun(dispatch.runId);
      if (run) return ACTIVE_RUN_STATUSES.includes(run.status) ? run : null;
    } catch (error) {
      if (!String(error.message || '').includes('404')) throw error;
    }
  }
  return io.findActiveRun();
}

/**
 * Perform one dispatch request, recording success/failure atomically in state.
 * @param {object} options
 * @returns {Promise<{action:'dispatched'|'retry', runId?:string, nextAt?:number, error?:string}>}
 */
async function dispatchMediaRun({ state, dispatch, config, now, io }) {
  try {
    await io.dispatchMedia();
  } catch (error) {
    const attempt = (dispatch.attempt || 0) + 1;
    const nextAt = now + dispatchBackoffMs(attempt, config);
    state.mediaDispatch = {
      ...dispatch,
      status: 'retry',
      attempt,
      nextAt,
      lastError: String(error.message || error),
      lastErrorAt: now,
    };
    return { action: 'retry', nextAt, error: state.mediaDispatch.lastError };
  }
  const base = {
    ...dispatch,
    status: 'dispatching',
    dispatches: (dispatch.dispatches || 0) + 1,
    dispatchedAt: now,
    checkAt: now + config.media.leaseMs,
    attempt: 0,
    nextAt: 0,
    lastError: '',
    lastErrorAt: 0,
    runId: '',
  };
  state.mediaDispatch = base;
  // Best-effort: record the concrete run id so later checks are a single GET.
  try {
    const active = await io.findActiveRun();
    if (active) state.mediaDispatch = { ...base, status: 'active', runId: String(active.id) };
  } catch {}
  return { action: 'dispatched', runId: state.mediaDispatch.runId || '' };
}

/**
 * Drive the media dispatch state machine for one alarm tick. Mutates and
 * returns `state.mediaDispatch`; never throws for dispatch/verify failures
 * (they are persisted for the next alarm/backoff).
 *
 * @param {object} options
 * @param {object} options.state - coordinator state (jobs + manifest + mediaDispatch)
 * @param {object} options.config - normalized site config
 * @param {object} options.io - `{dispatchMedia, findActiveRun, getRun?}`
 * @param {number} [options.now]
 * @param {{pending:boolean, running:boolean}} [options.queue] - precomputed queue facts
 * @returns {Promise<{action:string, runId?:string, nextAt?:number, error?:string}>} summary
 */
export async function driveMediaDispatch({ state, config, io, now = Date.now(), queue }) {
  const dispatch = normalizeMediaDispatch(state.mediaDispatch, state);
  state.mediaDispatch = dispatch;
  const pending = queue?.pending ?? Object.values(state.jobs).some((job) => job.status === 'pending');
  const running = queue?.running ?? Object.values(state.jobs).some((job) => job.status === 'running');
  const plan = planMediaDispatch({ dispatch, pending, running, now, config });
  if (plan.action === 'idle') {
    if (dispatch.status !== 'idle') state.mediaDispatch = { ...createMediaDispatch(), dispatches: dispatch.dispatches };
    return { action: 'idle' };
  }
  if (plan.action === 'wait') return { action: 'wait', checkAt: plan.checkAt };
  if (plan.action === 'dispatch') return dispatchMediaRun({ state, dispatch, config, now, io });

  // verify: does an active/queued media run already exist?
  let active;
  try {
    active = await observeActiveRun(io, dispatch);
  } catch (error) {
    dispatch.lastError = `Run verification: ${String(error.message || error)}`;
    dispatch.lastErrorAt = now;
    if (dispatch.status === 'active' || dispatch.status === 'dispatching') {
      // Keep waiting for the run we know about; retry verification shortly.
      dispatch.checkAt = now + Math.max(1, config.media.retryMs);
      state.mediaDispatch = dispatch;
      return { action: 'wait', checkAt: dispatch.checkAt, error: dispatch.lastError };
    }
    if (dispatch.status === 'retry') {
      dispatch.attempt = (dispatch.attempt || 0) + 1;
      dispatch.nextAt = now + dispatchBackoffMs(dispatch.attempt, config);
      state.mediaDispatch = dispatch;
      return { action: 'retry', nextAt: dispatch.nextAt, error: dispatch.lastError };
    }
    // Idle: verification unavailable, dispatch anyway (availability over caution;
    // the workflow concurrency group still serializes actual runs).
  }
  if (active) {
    state.mediaDispatch = {
      ...dispatch,
      status: 'active',
      runId: String(active.id),
      dispatchedAt: dispatch.dispatchedAt || now,
      checkAt: now + config.media.leaseMs,
      attempt: 0,
      misses: 0,
      lastError: '',
      lastErrorAt: 0,
    };
    return { action: 'active', runId: String(active.id) };
  }
  // No active/queued run while work is pending: the previous runner died or the
  // dispatch was lost (budget exit, crash, isolate eviction). Re-dispatch; after
  // repeated runner misses add backoff so a crash-looping runner cannot hot-loop.
  if (dispatch.status === 'active' || dispatch.status === 'dispatching') {
    dispatch.misses = (dispatch.misses || 0) + 1;
    if (dispatch.misses > 1) {
      const wait = dispatchBackoffMs(dispatch.misses, config);
      state.mediaDispatch = {
        ...dispatch,
        status: 'retry',
        attempt: dispatch.misses,
        nextAt: now + wait,
        lastError: 'Media run ended while tasks were still pending',
        lastErrorAt: now,
      };
      return { action: 'retry', nextAt: now + wait, error: state.mediaDispatch.lastError };
    }
  }
  return dispatchMediaRun({ state, dispatch, config, now, io });
}
