/**
 * Post-hoc video frame interpolation (「后补帧」).
 *
 * Backend contract (docs/experience-v2-plan.md §4, finalized by video-pipeline):
 * - `GET  /api/media/interpolate` → `{ ok, supported, defaults }` capability probe.
 * - `POST /api/media/interpolate` `{ slug?, filename?, all?, fps? }` →
 *   `{ ok, enqueued, tasks: [{ id, assetId }], skipped: [{ assetId, reason }] }`.
 *
 * The feature is detected once per session (404/405 before the Worker deploy)
 * and the UI hides/disables the action with a tooltip instead of failing on
 * click. All destructive/expensive actions are confirmed before enqueueing.
 */
import { mediaJobs } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=1';
import { toast, modalConfirm } from './ui.js?v=1';

const STORAGE_KEY = 'mosaic_interp_support'; // '1' available | '0' unsupported
const CHANGE_EVENT = 'mosaic:interpolate-support';

/** @type {'available'|'unavailable'|null} null = not confirmed yet */
let support = null;
let probePromise = null;

/** Read the session-cached probe result (null when never probed). */
function cachedSupport() {
  try {
    const cached = sessionStorage.getItem(STORAGE_KEY);
    if (cached === '1') return 'available';
    if (cached === '0') return 'unavailable';
  } catch {}
  return null;
}

/**
 * Current capability. Before the probe resolves this falls back to the config
 * shape (the `videoQuality.interpolation` key only exists on a v2 backend) so
 * buttons render optimistically; `ensureInterpolationSupport()` always
 * confirms the endpoint once per session.
 * @returns {'available'|'unavailable'|'unknown'}
 */
export function interpolationSupport() {
  if (support) return support;
  const cached = cachedSupport();
  if (cached) return (support = cached);
  if (state.config?.videoQuality?.interpolation) return 'available';
  return 'unknown';
}

/** @returns {boolean} Whether the 后补帧 UI may be shown. */
export function canInterpolate() {
  return interpolationSupport() !== 'unavailable';
}

function persistCapability(value) {
  support = value;
  try {
    sessionStorage.setItem(STORAGE_KEY, value === 'available' ? '1' : '0');
  } catch {}
  document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { support: value } }));
}

/**
 * Probe `GET /api/media/interpolate` once per session; safe to call from every
 * view that renders interpolation actions (the result is shared). Resolves with
 * the confirmed capability ('available' | 'unavailable' | 'unknown' on a
 * transient network failure).
 * @returns {Promise<'available'|'unavailable'|'unknown'>}
 */
export function ensureInterpolationSupport() {
  if (support) return Promise.resolve(support);
  const cached = cachedSupport();
  if (cached) {
    support = cached;
    return Promise.resolve(support);
  }
  if (probePromise) return probePromise;
  probePromise = (async () => {
    try {
      const result = await mediaJobs.interpolateCapability();
      persistCapability(result?.supported === false ? 'unavailable' : 'available');
    } catch (error) {
      if (error?.status === 404 || error?.status === 405) persistCapability('unavailable');
      // Network/transient failures keep the optimistic state so the action is
      // not hidden just because the probe itself failed.
    }
    return interpolationSupport();
  })().finally(() => {
    probePromise = null;
  });
  return probePromise;
}

/**
 * Subscribe to capability changes (e.g. a 404 discovered on click hides the
 * buttons without a reload). Returns an unsubscribe function.
 * @param {(support:string) => void} listener
 */
export function onInterpolationSupportChange(listener) {
  const handler = (event) => listener(event.detail?.support || interpolationSupport());
  document.addEventListener(CHANGE_EVENT, handler);
  return () => document.removeEventListener(CHANGE_EVENT, handler);
}

/** A video is interpolatable once its tiers are published (processed mode). */
export function isDecodedVideo(item) {
  if (!item) return false;
  return item.published === true || item.status === 'ready' || item.status === 'previous';
}

/** Original source file deleted by `keepSource=false` handling. */
export function isSourceMissing(item) {
  return item?.sourceAvailable === false || item?.source?.available === false || !!item?.sourceDeletedAt;
}

/** Target fps from the saved config (defaults to the contract default). */
export function currentInterpFps() {
  const fps = Number(state.config?.videoQuality?.interpolation?.fps);
  return Number.isFinite(fps) && fps >= 24 && fps <= 120 ? fps : 60;
}

// ── Requests ───────────────────────────────
async function requestInterpolation(body) {
  try {
    return await mediaJobs.interpolate(body);
  } catch (error) {
    if (error?.status === 404 || error?.status === 405) {
      persistCapability('unavailable');
      toast(t('interpolate.unavailable'), 'warning', 8000);
      return null;
    }
    throw error;
  }
}

function reportSkipped(skipped) {
  if (!skipped?.length) return;
  const preview = skipped
    .slice(0, 2)
    .map((entry) =>
      t('interpolate.skippedReason', {
        name: entry.assetId || entry.filename || '?',
        reason: entry.reason || t('common.unknown'),
      }),
    )
    .join('；');
  toast(t('interpolate.skippedTitle', { n: skipped.length }) + (preview ? ' — ' + preview : ''), 'warning', 10000);
}

function reportResult(result) {
  if (!result) return null;
  const enqueued = Number(result.enqueued) || result.tasks?.length || 0;
  if (enqueued > 0) {
    toast(t('interpolate.enqueued', { n: enqueued }), 'success', 8000, {
      label: t('interpolate.enqueuedAction'),
      onClick: () => {
        location.hash = 'build';
      },
    });
  } else if (!result.skipped?.length) {
    toast(t('interpolate.nothing'), 'info', 6000);
  }
  reportSkipped(result.skipped);
  window.checkDirty && window.checkDirty();
  return result;
}

function reportFailure(error, retry) {
  toast(
    t('interpolate.failed') + ': ' + (error?.message || ''),
    'error',
    10000,
    retry ? { label: t('interpolate.retry'), onClick: retry } : undefined,
  );
}

/**
 * Confirm and enqueue interpolation for one decoded video.
 * @param {{slug:string, filename:string, name?:string}} target
 */
export async function interpolateVideo({ slug, filename, name }) {
  modalConfirm(
    t('interpolate.confirmTitle', { name: name || filename }),
    t('interpolate.confirmDesc', { fps: currentInterpFps() }),
    async () => {
      try {
        reportResult(await requestInterpolation({ slug, filename }));
      } catch (error) {
        reportFailure(error, () => interpolateVideo({ slug, filename, name }));
      }
    },
    { danger: false, okLabel: t('interpolate.action') },
  );
}

/**
 * Confirm and enqueue interpolation for every decoded video of one post.
 * @param {{slug:string, count:number}} target
 */
export async function interpolatePost({ slug, count }) {
  modalConfirm(
    t('interpolate.postConfirmTitle', { slug }),
    t('interpolate.postConfirmDesc', { count, fps: currentInterpFps() }),
    async () => {
      try {
        reportResult(await requestInterpolation({ slug }));
      } catch (error) {
        reportFailure(error, () => interpolatePost({ slug, count }));
      }
    },
    { danger: false, okLabel: t('interpolate.action') },
  );
}

/**
 * Confirm and enqueue interpolation for every published video in the manifest.
 * @param {{knownCount?:number}} [options]
 */
export async function interpolateAll(options = {}) {
  modalConfirm(
    t('interpolate.allConfirmTitle'),
    t('interpolate.allConfirmDesc', {
      fps: currentInterpFps(),
      count: options.knownCount ? t('interpolate.knownCount', { n: options.knownCount }) : '',
    }),
    async () => {
      try {
        reportResult(await requestInterpolation({ all: true }));
      } catch (error) {
        reportFailure(error, () => interpolateAll(options));
      }
    },
    { danger: false, okLabel: t('interpolate.allConfirmOk') },
  );
}

/**
 * Follow one job through the existing jobs endpoints until it settles.
 * Resolves with the terminal job, or null when the wait timed out/aborted.
 * @param {string} taskId
 * @param {{signal?:AbortSignal, onUpdate?:(job:object)=>void, maxMs?:number}} [options]
 */
export async function followTask(taskId, { signal, onUpdate, maxMs = 600000 } = {}) {
  const interval = state.config.admin?.jobPollMs || 5000;
  const started = Date.now();
  while (!signal?.aborted && Date.now() - started < maxMs) {
    try {
      const job = await mediaJobs.get(taskId, { signal });
      if (signal?.aborted) return null;
      onUpdate?.(job);
      if (!['pending', 'running'].includes(job.status)) return job;
    } catch {
      if (signal?.aborted) return null;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return null;
}
