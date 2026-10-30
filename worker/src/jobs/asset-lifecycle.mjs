/**
 * Media v2 asset lifecycle — the durable, user-facing state of an asset.
 *
 * Job status is intentionally separate: a failed re-encode must not make an
 * asset with a healthy published generation look broken. Health carries those
 * transient reasons while `state` answers "can I use it / is it archived".
 */

const nowIso = (now = Date.now()) => new Date(now).toISOString();

export function newLifecycle(previous = null, now = Date.now()) {
  return {
    state: 'processing',
    uploadedAt: previous?.uploadedAt || nowIso(now),
    firstPublishedAt: previous?.firstPublishedAt || null,
    lastPublishedAt: previous?.lastPublishedAt || null,
    lastUsedAt: previous?.lastUsedAt || null,
    unusedSince: previous?.unusedSince || null,
    archivedAt: previous?.archivedAt || null,
    deletedAt: previous?.deletedAt || null,
    purgeAfter: previous?.purgeAfter || null,
    previousState: previous?.previousState || null,
    health: { level: 'ok', reasons: [] },
  };
}

export function markPublished(lifecycle, { complete = false, sourceAvailable = true, now = Date.now() } = {}) {
  const next = lifecycle || newLifecycle(null, now);
  const at = nowIso(now);
  next.state = complete ? 'ready' : 'processing';
  next.firstPublishedAt ||= at;
  next.lastPublishedAt = at;
  const reasons = [];
  if (!sourceAvailable) reasons.push('source-missing');
  next.health = { level: reasons.length ? 'degraded' : 'ok', reasons };
  return next;
}

export function markFailed(lifecycle, { hasPublished = false, now = Date.now() } = {}) {
  const next = lifecycle || newLifecycle(null, now);
  next.state = hasPublished ? 'degraded' : 'failed';
  next.health = { level: hasPublished ? 'degraded' : 'failed', reasons: ['latest-job-failed'] };
  return next;
}

export function markSourceMissing(lifecycle, now = Date.now()) {
  const next = lifecycle || newLifecycle(null, now);
  next.health = {
    level: 'degraded',
    reasons: [...new Set([...(next.health?.reasons || []), 'source-missing'])],
  };
  return next;
}

export function lifecycleView(asset) {
  const lifecycle = asset.lifecycle || newLifecycle(null, asset.createdAt ? Date.parse(asset.createdAt) : Date.now());
  return {
    ...lifecycle,
    state: asset.status === 'deleted' ? 'deleted' : lifecycle.state,
    health: lifecycle.health || { level: 'ok', reasons: [] },
  };
}
