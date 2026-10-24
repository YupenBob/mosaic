/**
 * Media processing task panel (rendered inside the Build page).
 *
 * Shows live task status, the job `options` (interpolation / keepSource /
 * sourceMode) and source-file availability, allows retry/cancel, and offers
 * batch post-hoc interpolation for every published video.
 *
 * Polling is owned by the page scope: leaving the page aborts the signal and
 * every timer. Task retries are processing-only — files are never re-uploaded.
 */
import { mediaJobs } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=1';
import { escHtml, toast, emptyState } from './ui.js?v=1';
import {
  canInterpolate,
  ensureInterpolationSupport,
  interpolationSupport,
  interpolateAll,
  isDecodedVideo,
  isSourceMissing,
} from './interpolate.js?v=1';

const ACTIVE = new Set(['pending', 'running', 'processing']);

/** Previous statuses so transitions can trigger exactly one notification. */
const previousStatus = new Map();

function badgeFor(status) {
  const map = {
    pending: ['badge-neutral', 'ri-time-line'],
    processing: ['badge-warning', 'ri-loader-4-line spin'],
    running: ['badge-warning', 'ri-loader-4-line spin'],
    ready: ['badge-success', 'ri-check-line'],
    failed: ['badge-danger', 'ri-error-warning-line'],
    cancelled: ['badge-neutral', 'ri-forbid-line'],
    superseded: ['badge-neutral', 'ri-refresh-line'],
    previous: ['badge-neutral', 'ri-history-line'],
  };
  return map[status] || ['badge-neutral', 'ri-question-line'];
}

/** Options chips: what this task is doing (interpolation / source handling). */
function optionChips(job) {
  const options = job.options || {};
  const chips = [];
  if (options.sourceMode === 'processed') chips.push({ icon: 'ri-film-line', label: t('jobs.sourceModeProcessed') });
  else if (options.sourceMode === 'original')
    chips.push({ icon: 'ri-file-video-line', label: t('jobs.sourceModeOriginal') });
  if (options.interpolation?.enabled)
    chips.push({
      icon: 'ri-timer-flash-line',
      label: `${t('jobs.interpolation')} ${options.interpolation.fps || 60}fps`,
    });
  if (options.keepSource === true) chips.push({ icon: 'ri-database-2-line', label: t('jobs.keepSource') });
  if (options.keepSource === false)
    chips.push({ icon: 'ri-delete-bin-6-line', label: t('jobs.deleteSource'), warn: true });
  if (job.published) chips.push({ icon: 'ri-global-line', label: t('jobs.published') });
  if (isSourceMissing(job))
    chips.push({
      icon: 'ri-error-warning-line',
      label: t('jobs.sourceDeleted'),
      warn: true,
      title: t('jobs.sourceDeletedHint'),
    });
  return chips
    .map(
      (chip) =>
        `<span class="job-chip${chip.warn ? ' job-chip--warn' : ''}"${chip.title ? ` title="${escHtml(chip.title)}"` : ''}><i class="${chip.icon}" aria-hidden="true"></i>${escHtml(chip.label)}</span>`,
    )
    .join('');
}

function jobRow(job) {
  const [badgeClass, badgeIcon] = badgeFor(job.status);
  const canRetry = ['failed', 'cancelled'].includes(job.status);
  const canCancel = ACTIVE.has(job.status);
  const filename = job.filename || job.id;
  return `<article class="media-job-row" data-job-id="${escHtml(job.id)}">
    <div class="media-job-main">
      <div class="media-job-head">
        <strong class="media-job-title" title="${escHtml(`${job.slug || ''} / ${filename}`)}">${escHtml(job.slug || '')} / ${escHtml(filename)}</strong>
        <span class="badge ${badgeClass}"><i class="${badgeIcon}" aria-hidden="true"></i>${escHtml(t('jobs.' + job.status) || job.status)}</span>
      </div>
      ${job.current ? `<p class="media-job-current"><i class="ri-loader-4-line spin" aria-hidden="true"></i> ${escHtml(job.current)}</p>` : ''}
      ${job.error ? `<p class="media-job-error"><i class="ri-error-warning-line" aria-hidden="true"></i> ${escHtml(job.error)}</p>` : ''}
      ${optionChips(job) ? `<div class="job-chips">${optionChips(job)}</div>` : ''}
    </div>
    <div class="media-job-actions">
      ${canRetry ? `<button type="button" class="btn btn-secondary btn-sm" data-job-action="retry" data-job-id="${escHtml(job.id)}"><i class="ri-refresh-line"></i> ${t('jobs.retry')}</button>` : ''}
      ${canCancel ? `<button type="button" class="btn btn-ghost btn-sm" data-job-action="cancel" data-job-id="${escHtml(job.id)}"><i class="ri-close-line"></i> ${t('jobs.cancel')}</button>` : ''}
    </div>
  </article>`;
}

function toolbar(jobs) {
  const active = jobs.filter((job) => ACTIVE.has(job.status)).length;
  const supported = canInterpolate();
  const disabled = !supported;
  const unsupported = interpolationSupport() === 'unavailable';
  const title = unsupported ? t('interpolate.unsupportedHint') : '';
  return `<div class="jobs-toolbar">
    <span class="jobs-summary" role="status">${t('jobs.count', { n: jobs.length })}${active ? ` · <span class="jobs-active">${t('jobs.activeCount', { n: active })}</span>` : ''}</span>
    <span class="jobs-toolbar-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-jobs-refresh aria-label="${t('jobs.refresh')}"><i class="ri-refresh-line"></i> ${t('jobs.refresh')}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-interp-all aria-label="${t('jobs.interpolateAll')}" title="${escHtml(title)}"${disabled ? ' disabled' : ''}><i class="ri-film-line"></i> ${t('jobs.interpolateAll')}</button>
    </span>
  </div>`;
}

function skeleton() {
  return `<div class="job-skeleton" role="status" aria-label="${t('common.loading')}">
    ${[1, 2].map(() => '<div class="job-skeleton-row"><div class="skeleton skeleton-line w60"></div><div class="skeleton skeleton-line w40"></div></div>').join('')}
  </div>`;
}

export function mountMediaJobs(signal) {
  const container = document.getElementById('media-job-list');
  if (!container) return;
  let timer = null;
  let jobs = [];
  let loadedOnce = false;
  let scaffolded = false;
  /** Cache keys so 5s polling never re-creates unchanged nodes (focus loss). */
  let toolbarKey = '';
  let bodyKey = '';

  const scaffold = () => {
    if (scaffolded) return;
    scaffolded = true;
    container.innerHTML = '<div data-jobs-toolbar></div><div data-jobs-body></div>';
    bodyKey = 'skeleton';
    container.querySelector('[data-jobs-body]').innerHTML = skeleton();
  };

  const render = (error) => {
    if (signal.aborted) return;
    scaffold();
    const toolbarEl = container.querySelector('[data-jobs-toolbar]');
    const bodyEl = container.querySelector('[data-jobs-body]');
    const active = jobs.filter((job) => ACTIVE.has(job.status)).length;
    const nextToolbarKey = `${jobs.length}|${active}|${interpolationSupport()}|${error ? 1 : 0}`;
    if (toolbarKey !== nextToolbarKey) {
      toolbarKey = nextToolbarKey;
      toolbarEl.innerHTML = toolbar(jobs);
    }
    const nextBodyKey = error
      ? `error:${jobs.length}`
      : jobs.length
        ? jobs.map((job) => `${job.id}:${job.status}:${job.current || ''}:${job.error || ''}`).join('|')
        : 'empty';
    if (bodyKey === nextBodyKey) return;
    bodyKey = nextBodyKey;
    bodyEl.innerHTML =
      (error
        ? `<div class="jobs-inline-error" role="alert"><i class="ri-error-warning-line" aria-hidden="true"></i><span>${t('common.partialError')}</span><button type="button" class="btn btn-ghost btn-sm" data-jobs-reload><i class="ri-refresh-line" aria-hidden="true"></i> ${t('jobs.retryLoad')}</button></div>`
        : '') +
      (jobs.length
        ? `<div class="job-list">${jobs.map(jobRow).join('')}</div>`
        : emptyState('ri-hard-drive-3-line', t('jobs.noneTitle'), t('jobs.noneDesc')));
  };

  const renderFatalError = () => {
    if (signal.aborted) return;
    scaffolded = true;
    toolbarKey = '';
    bodyKey = 'fatal';
    container.innerHTML = `<div class="jobs-error" role="alert"><i class="ri-error-warning-line" aria-hidden="true"></i><span>${t('jobs.loadFailed')}</span><button type="button" class="btn btn-secondary btn-sm" data-jobs-reload><i class="ri-refresh-line"></i> ${t('jobs.retryLoad')}</button></div>`;
  };

  const notifyTransitions = (next) => {
    for (const job of next) {
      const prev = previousStatus.get(job.id);
      previousStatus.set(job.id, job.status);
      if (!prev || prev === job.status) continue;
      if (!job.options?.interpolation?.enabled) continue;
      if (!ACTIVE.has(prev)) continue;
      if (job.status === 'ready') toast(`${t('interpolate.done')} · ${job.filename || job.id}`, 'success', 5000);
      else if (job.status === 'failed')
        toast(
          `${t('interpolate.taskFailed')} · ${job.filename || job.id}${job.error ? ' — ' + job.error : ''}`,
          'error',
          9000,
          {
            label: t('jobs.retry'),
            onClick: () => action('retry', job.id),
          },
        );
    }
  };

  const refresh = async () => {
    try {
      const result = await mediaJobs.list({ signal });
      if (signal.aborted) return;
      jobs = result.jobs || [];
      loadedOnce = true;
      notifyTransitions(jobs);
      render();
    } catch (error) {
      if (signal.aborted) return;
      if (loadedOnce) render(error);
      else renderFatalError();
    }
    if (!signal.aborted) timer = setTimeout(refresh, state.config.admin?.jobPollMs || 5000);
  };

  const action = async (name, id) => {
    try {
      await mediaJobs[name](id);
      clearTimeout(timer);
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  container.addEventListener(
    'click',
    async (event) => {
      const jobButton = event.target.closest('[data-job-action]');
      if (jobButton) {
        jobButton.disabled = true;
        await action(jobButton.dataset.jobAction, jobButton.dataset.jobId);
        return;
      }
      if (event.target.closest('[data-jobs-refresh]')) {
        clearTimeout(timer);
        refresh();
        return;
      }
      if (event.target.closest('[data-jobs-reload]')) {
        clearTimeout(timer);
        loadedOnce = false;
        bodyKey = 'skeleton';
        container.innerHTML = '<div data-jobs-toolbar></div><div data-jobs-body></div>';
        container.querySelector('[data-jobs-body]').innerHTML = skeleton();
        toolbarKey = '';
        refresh();
        return;
      }
      if (event.target.closest('[data-interp-all]')) {
        interpolateAll({ knownCount: jobs.filter((job) => isDecodedVideo(job)).length });
      }
    },
    { signal },
  );
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

  scaffold();
  ensureInterpolationSupport().then(() => {
    if (!signal.aborted) render();
  });
  refresh();
}
