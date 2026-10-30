/**
 * Media task center — a dedicated, filterable view of processing jobs.
 *
 * The build page stays focused on deploying the site. This page owns the
 * per-file queue: active, failed and completed jobs, with retry/cancel and the
 * last error in one place. It uses the existing `/api/media-jobs` contract and
 * will keep working when jobs gain richer stages in Media v2.
 */
import { mediaJobs } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { escHtml, formatTime, toast, emptyState } from './ui.js?v=1';

const ACTIVE = new Set(['pending', 'running', 'processing']);
const STATUS_CLASS = {
  pending: 'badge-neutral',
  processing: 'badge-warning',
  running: 'badge-warning',
  ready: 'badge-success',
  failed: 'badge-danger',
  cancelled: 'badge-neutral',
  superseded: 'badge-neutral',
  previous: 'badge-neutral',
};

function statusBadge(status) {
  return `<span class="badge ${STATUS_CLASS[status] || 'badge-neutral'}">${escHtml(t('jobs.' + status) || status)}</span>`;
}

function jobRow(job) {
  const filename = job.filename || job.id;
  const canRetry = ['failed', 'cancelled'].includes(job.status);
  const canCancel = ACTIVE.has(job.status);
  const progress = job.current
    ? `<p class="media-job-current"><i class="ri-loader-4-line spin" aria-hidden="true"></i> ${escHtml(job.current)}</p>`
    : '';
  const error = job.error
    ? `<p class="media-job-error"><i class="ri-error-warning-line" aria-hidden="true"></i> ${escHtml(job.error)}</p>`
    : '';
  return `<article class="media-job-row" data-job-id="${escHtml(job.id)}">
    <div class="media-job-main">
      <div class="media-job-head">
        <strong class="media-job-title" title="${escHtml(`${job.slug || ''} / ${filename}`)}">${escHtml(job.slug || '')} / ${escHtml(filename)}</strong>
        ${statusBadge(job.status)}
      </div>
      ${progress}${error}
      <p class="media-job-meta">${escHtml(t('tasks.kind.' + (job.kind || 'media')))} · ${escHtml(t('tasks.operation.' + (job.operation || 'process')))}${job.sourceMode ? ` · ${escHtml(t('tasks.source.' + job.sourceMode))}` : ''}${job.createdAt ? ` · ${escHtml(formatTime(job.createdAt))}` : ''}${job.attempts ? ` · ${t('tasks.attempts', { n: job.attempts })}` : ''}</p>
    </div>
    <div class="media-job-actions">
      ${canRetry ? `<button type="button" class="btn btn-secondary btn-sm" data-job-action="retry" data-job-id="${escHtml(job.id)}"><i class="ri-refresh-line" aria-hidden="true"></i> ${t('jobs.retry')}</button>` : ''}
      ${canCancel ? `<button type="button" class="btn btn-ghost btn-sm" data-job-action="cancel" data-job-id="${escHtml(job.id)}"><i class="ri-close-line" aria-hidden="true"></i> ${t('jobs.cancel')}</button>` : ''}
    </div>
  </article>`;
}

function filterJobs(jobs, filter) {
  if (filter === 'active') return jobs.filter((job) => ACTIVE.has(job.status));
  if (filter === 'failed') return jobs.filter((job) => job.status === 'failed');
  if (filter === 'done')
    return jobs.filter((job) => ['ready', 'cancelled', 'superseded', 'previous'].includes(job.status));
  return jobs;
}

export default async function renderTasks(signal) {
  let jobs = [];
  let loadError = '';
  try {
    const result = await mediaJobs.list({ signal });
    jobs = result.jobs || [];
  } catch (error) {
    if (signal.aborted) return '';
    loadError = error.message || '';
  }
  if (signal.aborted) return '';

  const active = jobs.filter((job) => ACTIVE.has(job.status)).length;
  const failed = jobs.filter((job) => job.status === 'failed').length;
  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>${t('tasks.title')}</h1>
            <p class="page-subtitle">${t('tasks.subtitle', { active, failed })}</p>
          </div>
          <div class="page-header-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-tasks-refresh><i class="ri-refresh-line" aria-hidden="true"></i> ${t('tasks.refresh')}</button>
          </div>
        </div>
        <div class="toolbar-row">
          <div class="task-filters" role="group" aria-label="${t('tasks.filter')}">
            <button type="button" class="task-filter-btn active" data-task-filter="all">${t('tasks.all')}</button>
            <button type="button" class="task-filter-btn" data-task-filter="active">${t('tasks.active')}</button>
            <button type="button" class="task-filter-btn" data-task-filter="failed">${t('tasks.failed')}</button>
            <button type="button" class="task-filter-btn" data-task-filter="done">${t('tasks.done')}</button>
          </div>
          <span class="search-count" id="tasks-count"></span>
        </div>
        <section class="card media-jobs">
          <div id="tasks-list" role="status" aria-live="polite">
            ${loadError ? `<div class="page-load-error" role="alert">${escHtml(loadError)}</div>` : jobs.length ? '' : emptyState('ri-hard-drive-3-line', t('tasks.emptyTitle'), t('tasks.emptyDesc'))}
          </div>
        </section>
      </div>
    `,
    onMount() {
      let timer = null;
      let currentFilter = 'all';
      let currentJobs = jobs;

      const renderList = () => {
        if (signal.aborted) return;
        const listEl = document.getElementById('tasks-list');
        if (!listEl) return;
        const list = filterJobs(currentJobs, currentFilter);
        const count = document.getElementById('tasks-count');
        if (count) count.textContent = t('tasks.count', { n: list.length });
        listEl.innerHTML = list.length
          ? list.map(jobRow).join('')
          : emptyState('ri-checkbox-circle-line', t('tasks.emptyTitle'), t('tasks.emptyDesc'));
      };

      const load = async ({ silent = false } = {}) => {
        try {
          const result = await mediaJobs.list({ signal });
          if (signal.aborted) return;
          currentJobs = result.jobs || [];
          const activeCount = currentJobs.filter((job) => ACTIVE.has(job.status)).length;
          const failedCount = currentJobs.filter((job) => job.status === 'failed').length;
          const subtitle = document.querySelector('.page-subtitle');
          if (subtitle) subtitle.textContent = t('tasks.subtitle', { active: activeCount, failed: failedCount });
          renderList();
          if (!silent) toast(t('tasks.refreshed'), 'info', 1500);
        } catch (error) {
          if (signal.aborted) return;
          if (!silent) toast(t('tasks.loadFailed') + ': ' + (error.message || ''), 'error');
        }
      };

      const schedule = () => {
        clearTimeout(timer);
        if (signal.aborted) return;
        const hasActive = currentJobs.some((job) => ACTIVE.has(job.status));
        timer = setTimeout(
          async () => {
            await load({ silent: true });
            schedule();
          },
          hasActive ? 5000 : 30000,
        );
      };

      document.querySelector('[data-tasks-refresh]')?.addEventListener('click', () => load());
      document.querySelectorAll('[data-task-filter]').forEach((button) => {
        button.addEventListener('click', () => {
          currentFilter = button.dataset.taskFilter;
          document.querySelectorAll('[data-task-filter]').forEach((item) => {
            item.classList.toggle('active', item === button);
            item.setAttribute('aria-pressed', item === button ? 'true' : 'false');
          });
          renderList();
        });
      });

      document.getElementById('tasks-list')?.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-job-action]');
        if (!button) return;
        const id = button.dataset.jobId;
        const action = button.dataset.jobAction;
        button.disabled = true;
        try {
          if (action === 'retry') await mediaJobs.retry(id);
          else await mediaJobs.cancel(id);
          toast(action === 'retry' ? t('tasks.retryQueued') : t('tasks.cancelRequested'), 'success', 2200);
          await load({ silent: true });
        } catch (error) {
          toast(t('common.error') + ': ' + (error.message || ''), 'error');
          button.disabled = false;
        }
      });

      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
        },
        { once: true },
      );
      renderList();
      schedule();
    },
  };
}

export const tasksSkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:130px;height:30px"></div></div>
    <div class="skeleton-card">${[1, 2, 3].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
  </div>
`;
