/**
 * R2 media usage snapshot (site-data/media-usage.json).
 *
 * Uploads/deletes adjust a persisted {size, objects, updatedAt} snapshot so
 * /api/disk doesn't need a full bucket listing on every read. Bulk operations
 * (post delete, cleanup delete, processed-cache flush) invalidate the snapshot
 * so the next read falls back to a full parallel listing and rewrites it.
 */
const SNAPSHOT_KEY = 'site-data/media-usage.json';
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function readUsageSnapshot(env) {
  try {
    const obj = await env.MEDIA.get(SNAPSHOT_KEY);
    if (!obj) return null;
    const snap = JSON.parse(await obj.text());
    if (!snap || typeof snap.size !== 'number' || typeof snap.objects !== 'number' || !snap.updatedAt) return null;
    return snap;
  } catch {
    return null;
  }
}

export async function writeUsageSnapshot(env, size, objects) {
  try {
    await env.MEDIA.put(SNAPSHOT_KEY, JSON.stringify({ size, objects, updatedAt: Date.now() }));
  } catch {}
}

export async function invalidateUsageSnapshot(env) {
  try {
    await env.MEDIA.delete(SNAPSHOT_KEY);
  } catch {}
}

/**
 * Apply a delta to the snapshot. A missing/stale snapshot is left alone: the
 * next getDiskUsage() will rebuild it from a full listing, which bounds drift.
 */
export async function adjustUsage(env, deltaSize, deltaObjects) {
  try {
    const snap = await readUsageSnapshot(env);
    if (!snap || Date.now() - snap.updatedAt > SNAPSHOT_MAX_AGE_MS) return;
    await writeUsageSnapshot(env, Math.max(0, snap.size + deltaSize), Math.max(0, snap.objects + deltaObjects));
  } catch {}
}
