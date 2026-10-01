import { jobsRequest } from './jobs.js';
// ====== Dirty State (R2 + memory) ======
const DIRTY_KEY = 'site-data/dirty.json';
let _dirtyState = null; // { count: number, last: ISO string }

export async function isDirty(env) {
  if (env.JOBS) {
    const dirty = await jobsRequest(env, 'dirty-state');
    return dirty.count || dirty.contentDirty ? dirty : null;
  }
  if (_dirtyState) return _dirtyState;
  try {
    const obj = await env.MEDIA.get(DIRTY_KEY);
    if (obj) _dirtyState = JSON.parse(await obj.text());
  } catch {}
  return _dirtyState;
}

export async function markDirty(env, gitSha = '') {
  if (env.JOBS) return jobsRequest(env, 'dirty', { gitSha });
  const now = new Date().toISOString();
  if (_dirtyState) {
    _dirtyState.count++;
    _dirtyState.last = now;
  } else _dirtyState = { count: 1, last: now };
  try {
    await env.MEDIA.put(DIRTY_KEY, JSON.stringify(_dirtyState), { httpMetadata: { contentType: 'application/json' } });
  } catch (e) {
    console.error('markDirty: R2 write failed (memory state kept for this session)', e.message);
  }
}

export async function clearDirty(env) {
  if (env.JOBS) throw new Error('Dirty state requires a verified deployment acknowledgement');
  _dirtyState = null;
  try {
    await env.MEDIA.delete(DIRTY_KEY);
  } catch (e) {
    // If the delete fails, the next isDirty() read would resurrect the stale
    // R2 flag — retry once and surface the error instead of swallowing it.
    console.error('clearDirty: R2 delete failed, retrying', e.message);
    try {
      await env.MEDIA.delete(DIRTY_KEY);
    } catch (e2) {
      console.error('clearDirty: retry failed — banner may persist until next build', e2.message);
    }
  }
}
