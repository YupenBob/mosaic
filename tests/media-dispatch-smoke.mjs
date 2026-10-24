/**
 * Media-workflow dispatch state-machine tests: pure planner + driver against
 * fake GitHub I/O, plus coordinator alarm integration proving no duplicate
 * dispatch while a run is queued/running, recovery after a runner dies with
 * pending work, exponential backoff for dispatch errors, persistence across
 * restarts, and that site-build dispatch is independent of media failures.
 *
 * Run: node tests/media-dispatch-smoke.mjs (also imported by tests/jobs-smoke.mjs)
 */
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';
import { normalizeConfig } from '../shared/config.mjs';
import {
  createMediaDispatch,
  driveMediaDispatch,
  mediaDispatchWakeAt,
  planMediaDispatch,
} from '../worker/src/jobs/media-dispatch.mjs';

const checks = [];
/** @param {string} name @param {() => (void|Promise<void>)} fn */
async function check(name, fn) {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (error) {
    checks.push(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}

const config = normalizeConfig({ media: { retryMs: 1000, leaseMs: 60000, pollMs: 10000, debounceMs: 0 } });
const now = 1_700_000_000_000;

/** Fresh coordinator-state stub with one pending job. */
function makeState(dispatch = createMediaDispatch()) {
  return {
    jobs: { task: { id: 'task', status: 'pending' } },
    manifest: { assets: {} },
    mediaDispatch: dispatch,
  };
}

/** Fake GitHub I/O with configurable run observations. */
function fakeIo({ active = null, run = null, dispatchError = null, verifyError = null } = {}) {
  const calls = { dispatch: 0, verify: 0, runChecks: 0 };
  const io = {
    calls,
    active,
    run,
    dispatchError,
    verifyError,
    async dispatchMedia() {
      calls.dispatch++;
      if (io.dispatchError) throw new Error(io.dispatchError);
    },
    async findActiveRun() {
      calls.verify++;
      if (io.verifyError) throw new Error(io.verifyError);
      return io.active;
    },
    async getRun() {
      calls.runChecks++;
      return io.run;
    },
  };
  return io;
}

await check('planner never dispatches while a runner holds a lease', () => {
  const dispatch = createMediaDispatch();
  assert.deepEqual(planMediaDispatch({ dispatch, pending: true, running: true, now, config }), {
    action: 'wait',
    checkAt: now + config.media.pollMs,
  });
  assert.deepEqual(planMediaDispatch({ dispatch, pending: false, running: false, now, config }), { action: 'idle' });
});

await check('planner throttle/verify/backoff windows', () => {
  const active = { ...createMediaDispatch(), status: 'dispatching', dispatchedAt: now, checkAt: now + 5000 };
  assert.deepEqual(planMediaDispatch({ dispatch: active, pending: true, running: false, now: now + 1, config }), {
    action: 'wait',
    checkAt: now + 5000,
  });
  assert.deepEqual(planMediaDispatch({ dispatch: active, pending: true, running: false, now: now + 5000, config }), {
    action: 'verify',
  });
  const retry = { ...createMediaDispatch(), status: 'retry', nextAt: now + 2000 };
  assert.deepEqual(planMediaDispatch({ dispatch: retry, pending: true, running: false, now: now + 1, config }), {
    action: 'wait',
    checkAt: now + 2000,
  });
  assert.deepEqual(planMediaDispatch({ dispatch: retry, pending: true, running: false, now: now + 2000, config }), {
    action: 'verify',
  });
  // Idle with pending work verifies for orphaned runs before dispatching.
  assert.deepEqual(planMediaDispatch({ dispatch: createMediaDispatch(), pending: true, running: false, now, config }), {
    action: 'verify',
  });
});

await check('planner wake-up times for retry/active states', () => {
  assert.equal(mediaDispatchWakeAt(createMediaDispatch(), config, now), 0);
  const retry = { ...createMediaDispatch(), status: 'retry', nextAt: now + 1234 };
  assert.equal(mediaDispatchWakeAt(retry, config, now), now + 1234);
  const active = { ...createMediaDispatch(), status: 'active', checkAt: now + 4321 };
  assert.equal(mediaDispatchWakeAt(active, config, now), now + 4321);
});

await check('driver dispatches once, then suppresses duplicates while queued/running', async () => {
  const state = makeState();
  const io = fakeIo();
  const first = await driveMediaDispatch({ state, config, io, now, queue: { pending: true, running: false } });
  assert.equal(first.action, 'dispatched');
  assert.equal(io.calls.dispatch, 1);
  assert.equal(state.mediaDispatch.status, 'dispatching');
  // A queued run appears: later alarms must verify, never dispatch again.
  io.active = { id: 42, status: 'queued' };
  const early = await driveMediaDispatch({
    state,
    config,
    io,
    now: now + 1,
    queue: { pending: true, running: false },
  });
  assert.equal(early.action, 'wait');
  assert.equal(io.calls.dispatch, 1);
  const verified = await driveMediaDispatch({
    state,
    config,
    io,
    now: state.mediaDispatch.checkAt,
    queue: { pending: true, running: false },
  });
  assert.equal(verified.action, 'active');
  assert.equal(verified.runId, '42');
  assert.equal(io.calls.dispatch, 1);
  // Running run: still no duplicate.
  io.run = { id: 42, status: 'in_progress' };
  const running = await driveMediaDispatch({
    state,
    config,
    io,
    now: state.mediaDispatch.checkAt,
    queue: { pending: true, running: false },
  });
  assert.equal(running.action, 'active');
  assert.equal(io.calls.dispatch, 1);
});

await check('driver re-dispatches when the verified run ended with pending work', async () => {
  const state = makeState({
    ...createMediaDispatch(),
    status: 'active',
    runId: '42',
    dispatchedAt: now,
    checkAt: now,
  });
  const io = fakeIo({ run: { id: 42, status: 'completed' }, active: null });
  const recovered = await driveMediaDispatch({ state, config, io, now, queue: { pending: true, running: false } });
  assert.equal(recovered.action, 'dispatched', 'budget-exit/crash runner must trigger a new workflow run');
  assert.equal(io.calls.dispatch, 1);
});

await check('repeated runner misses back off instead of hot-looping', async () => {
  const state = makeState({
    ...createMediaDispatch(),
    status: 'active',
    runId: '42',
    dispatchedAt: now,
    checkAt: now,
    misses: 1,
  });
  const io = fakeIo({ run: { id: 42, status: 'completed' }, active: null });
  const backedOff = await driveMediaDispatch({ state, config, io, now, queue: { pending: true, running: false } });
  assert.equal(backedOff.action, 'retry');
  assert.equal(io.calls.dispatch, 0);
  assert.equal(state.mediaDispatch.misses, 2);
  assert.ok(state.mediaDispatch.nextAt > now);
  const waiting = await driveMediaDispatch({
    state,
    config,
    io,
    now: now + 1,
    queue: { pending: true, running: false },
  });
  assert.equal(waiting.action, 'wait');
});

await check('dispatch errors use exponential backoff and recover', async () => {
  const state = makeState();
  const io = fakeIo({ dispatchError: 'GitHub offline' });
  const failed = await driveMediaDispatch({ state, config, io, now, queue: { pending: true, running: false } });
  assert.equal(failed.action, 'retry');
  assert.equal(state.mediaDispatch.attempt, 1);
  assert.equal(state.mediaDispatch.nextAt, now + config.media.retryMs);
  const early = await driveMediaDispatch({
    state,
    config,
    io,
    now: now + 1,
    queue: { pending: true, running: false },
  });
  assert.equal(early.action, 'wait');
  assert.equal(io.calls.dispatch, 1, 'failed dispatch is not retried before backoff');
  const second = await driveMediaDispatch({
    state,
    config,
    io,
    now: now + config.media.retryMs,
    queue: { pending: true, running: false },
  });
  assert.equal(second.action, 'retry');
  assert.equal(state.mediaDispatch.attempt, 2);
  assert.equal(state.mediaDispatch.nextAt, now + config.media.retryMs + config.media.retryMs * 2);
  // GitHub recovers: verify finds no active run, then dispatch succeeds.
  io.dispatchError = null;
  const recovered = await driveMediaDispatch({
    state,
    config,
    io,
    now: state.mediaDispatch.nextAt,
    queue: { pending: true, running: false },
  });
  assert.equal(recovered.action, 'dispatched');
  assert.equal(state.mediaDispatch.attempt, 0);
  assert.equal(state.mediaDispatch.lastError, '');
});

await check('verification failures do not duplicate an in-flight dispatch', async () => {
  const state = makeState({
    ...createMediaDispatch(),
    status: 'dispatching',
    dispatchedAt: now,
    checkAt: now,
  });
  const io = fakeIo({ verifyError: 'GitHub 403' });
  const result = await driveMediaDispatch({ state, config, io, now, queue: { pending: true, running: false } });
  assert.equal(result.action, 'wait');
  assert.equal(io.calls.dispatch, 0);
  assert.ok(state.mediaDispatch.checkAt > now);
  assert.match(state.mediaDispatch.lastError, /verification/i);
});

await check('driver becomes idle once no task work is left', async () => {
  const state = makeState({ ...createMediaDispatch(), status: 'active', runId: '42', checkAt: now + 1 });
  const io = fakeIo();
  const result = await driveMediaDispatch({ state, config, io, now, queue: { pending: false, running: false } });
  assert.equal(result.action, 'idle');
  assert.equal(state.mediaDispatch.status, 'idle');
  assert.equal(mediaDispatchWakeAt(state.mediaDispatch, config, now), 0);
});

// ── Coordinator alarm integration (real Jobs DO + memory R2 + mocked GitHub) ──
function installGitHubMock() {
  const original = globalThis.fetch;
  const calls = { mediaDispatch: 0, siteDispatch: 0, runList: 0 };
  const mock = {
    calls,
    activeRuns: [],
    runStatus: null,
    failMediaDispatch: false,
    failSiteDispatch: false,
  };
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    if (address.includes('/dispatches')) {
      if (address.includes('media.yml')) {
        calls.mediaDispatch++;
        if (mock.failMediaDispatch) throw new Error('GitHub offline');
      } else if (address.includes('pipeline.yml')) {
        calls.siteDispatch++;
        if (mock.failSiteDispatch) throw new Error('GitHub site offline');
      }
      return new Response(null, { status: 204 });
    }
    if (address.includes('/actions/runs/')) return Response.json(mock.runStatus || {});
    if (address.includes('/actions/workflows/') && address.includes('/runs')) {
      calls.runList++;
      return Response.json({ workflow_runs: mock.activeRuns });
    }
    if (address.includes('api.github.com')) return Response.json({});
    throw new Error(`Unexpected fetch: ${address} ${options.method || ''}`);
  };
  return { mock, restore: () => (globalThis.fetch = original) };
}

await check('alarm dispatches once, persists state, and suppresses immediate duplicates', async () => {
  const runtime = createRuntime();
  await runtime.enqueue('flow', 'clip.mp4');
  const github = installGitHubMock();
  try {
    await runtime.alarm();
    assert.equal(github.mock.calls.mediaDispatch, 1);
    let state = await runtime.call('state');
    assert.ok(['dispatching', 'active'].includes(state.mediaDispatch.status));
    assert.equal(state.mediaDispatch.dispatches, 1);
    // Alarm immediately again: the in-flight dispatch window must suppress it.
    await runtime.alarm();
    assert.equal(github.mock.calls.mediaDispatch, 1, 'no duplicate dispatch while a run may be queued');
    // Persisted across an isolate restart.
    runtime.restart();
    state = await runtime.call('state');
    assert.equal(state.mediaDispatch.dispatches, 1);
  } finally {
    github.restore();
  }
});

await check('alarm observes an existing queued run via run id and run list', async () => {
  const runtime = createRuntime();
  await runtime.enqueue('flow', 'clip.mp4');
  const github = installGitHubMock();
  try {
    github.mock.activeRuns = [{ id: 42, status: 'queued' }];
    await runtime.alarm();
    assert.equal(github.mock.calls.mediaDispatch, 0, 'never dispatch while a media run is queued');
    let state = await runtime.call('state');
    assert.equal(state.mediaDispatch.status, 'active');
    assert.equal(state.mediaDispatch.runId, '42');
    // Run id is used for later checks; completed run + pending task re-dispatches.
    github.mock.runStatus = { id: 42, status: 'completed' };
    github.mock.activeRuns = [];
    const persisted = runtime.persistent.get('state');
    persisted.mediaDispatch.checkAt = 0;
    runtime.restart();
    await runtime.alarm();
    assert.equal(github.mock.calls.mediaDispatch, 1, 'runner death with pending work triggers the flow again');
  } finally {
    github.restore();
  }
});

await check('site build dispatch stays independent of media dispatch failures', async () => {
  const runtime = createRuntime();
  await runtime.enqueue('flow', 'clip.mp4');
  const github = installGitHubMock();
  try {
    github.mock.failMediaDispatch = true;
    await runtime.alarm();
    assert.match(runtime.persistent.get('state').lastDispatchError, /offline/);
    assert.equal(github.mock.calls.siteDispatch, 1, 'site build dispatched despite media failure');
    assert.equal(runtime.persistent.get('state').buildPending, false);
    // Media dispatch retry is backed off; a later alarm retries it.
    github.mock.failMediaDispatch = false;
    const persisted = runtime.persistent.get('state');
    persisted.mediaDispatch.nextAt = 0;
    runtime.restart();
    await runtime.alarm();
    assert.equal(github.mock.calls.mediaDispatch, 2);
    assert.equal(runtime.persistent.get('state').mediaDispatch.status, 'dispatching');
  } finally {
    github.restore();
  }
});

await check('legacy mediaDispatchAt state upgrades to the state machine', () => {
  const runtime = createRuntime();
  return runtime.call('state').then(() => {
    const persisted = runtime.persistent.get('state');
    delete persisted.mediaDispatch;
    persisted.mediaDispatchAt = Date.now() - 1000;
    runtime.restart();
    return runtime.call('state').then((state) => {
      assert.equal(state.mediaDispatch.status, 'dispatching');
      assert.ok(state.mediaDispatch.checkAt > Date.now());
    });
  });
});

console.log(checks.join('\n'));
console.log(`\nMedia dispatch smoke: ${checks.length} groups passed`);
