import assert from 'node:assert/strict';
import { apiFetch, configureClient, setToken, setNavigationSignal } from '../cloud-admin/src/api.js';
const original = globalThis.fetch;
let calls = 0,
  pending,
  upstreamSignal;
try {
  setToken('fixture-token');
  configureClient({ cacheMs: 1000, buildCacheMs: 0, requestTimeoutMs: 1000 });
  globalThis.fetch = async (_url, options) => {
    calls++;
    upstreamSignal = options.signal;
    return new Promise((resolve, reject) => {
      pending = resolve;
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };
  const page = new AbortController();
  const leaving = apiFetch('/config', { signal: page.signal });
  const visible = apiFetch('/config', { signal: null });
  assert.equal(calls, 1, 'concurrent reads coalesce');
  page.abort();
  await assert.rejects(leaving, { name: 'AbortError' });
  assert.equal(upstreamSignal.aborted, false, 'another consumer keeps the shared request alive');
  pending(Response.json({ title: 'Fixture' }));
  assert.equal((await visible).title, 'Fixture');
  assert.equal((await apiFetch('/config', { signal: null })).title, 'Fixture');
  assert.equal(calls, 1, 'cached reads avoid another request');
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ ok: true });
  };
  await apiFetch('/posts', { method: 'POST', body: '{}' });
  await apiFetch('/config', { signal: null });
  assert.equal(calls, 3, 'writes invalidate read caches');
  configureClient({ buildCacheMs: 60000, requestTimeoutMs: 1000 });
  const responses = [];
  globalThis.fetch = async (_url, options) => {
    calls++;
    return new Promise((resolve) => responses.push({ resolve, cache: options.cache }));
  };
  const initialStatus = apiFetch('/build/status');
  responses[0].resolve(Response.json({ runNumber: 1 }));
  await initialStatus;
  const cachedCalls = calls;
  assert.equal((await apiFetch('/build/status')).runNumber, 1);
  assert.equal(calls, cachedCalls, 'background build reads keep the cache');
  const refreshed = apiFetch('/build/status', { cache: 'no-store' });
  assert.equal(calls, cachedCalls + 1, 'explicit refresh bypasses a warm build cache');
  assert.equal(responses[1].cache, 'no-store', 'refresh also bypasses the browser HTTP cache');
  responses[1].resolve(Response.json({ runNumber: 2 }));
  assert.equal((await refreshed).runNumber, 2);
  const olderPoll = apiFetch('/build/status');
  const freshDuringPoll = apiFetch('/build/status', { cache: 'no-store' });
  assert.equal(calls, cachedCalls + 3, 'refresh bypasses an older in-flight poll');
  responses[3].resolve(Response.json({ runNumber: 4 }));
  assert.equal((await freshDuringPoll).runNumber, 4);
  responses[2].resolve(Response.json({ runNumber: 3 }));
  await olderPoll;
  const nextPoll = apiFetch('/build/status');
  assert.equal(calls, cachedCalls + 4, 'older poll cannot repopulate the cache after refresh');
  responses[4].resolve(Response.json({ runNumber: 4 }));
  await nextPoll;
  await apiFetch('/build/status');
  assert.equal(calls, cachedCalls + 4, 'subsequent background polling still caches');
  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      upstreamSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  const last = new AbortController();
  const abandoned = apiFetch('/media/post/list', { signal: last.signal });
  last.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });
  assert.equal(upstreamSignal.aborted, true, 'last consumer cancels upstream');
  configureClient({ requestTimeoutMs: 20 });
  await assert.rejects(apiFetch('/health', { signal: null }), { name: 'TimeoutError' });
  await assert.rejects(apiFetch('/upload/complete/post/clip.mp4', { method: 'POST', signal: null }), {
    name: 'TimeoutError',
  });
  setNavigationSignal(null);
  console.log(
    'Admin client: coalesced reads, fresh refreshes, cache invalidation, independent cancellation and bounded timeout passed',
  );
} finally {
  setToken(null);
  globalThis.fetch = original;
}
