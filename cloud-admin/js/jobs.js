import { mediaJobs } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { escHtml, toast } from './ui.js?v=1';
import { state } from './state.js?v=1';
export function mountMediaJobs(signal) {
  const container = document.getElementById('media-job-list');
  if (!container) return;
  let timer;
  const refresh = async () => {
    try {
      const { jobs } = await mediaJobs.list({ signal });
      if (signal.aborted) return;
      container.innerHTML = jobs.length
        ? jobs
            .slice()
            .reverse()
            .map(
              (job) =>
                `<div class="media-job-row"><div><strong>${escHtml(job.slug)} / ${escHtml(job.filename)}</strong><p>${escHtml(t(`jobs.${job.status}`))}${job.current ? ' · ' + escHtml(job.current) : ''}</p>${job.error ? `<p class="error">${escHtml(job.error)}</p>` : ''}</div><div>${['failed', 'cancelled'].includes(job.status) ? `<button class="btn btn-secondary btn-sm" data-job-action="retry" data-job-id="${escHtml(job.id)}">${t('jobs.retry')}</button>` : ''}${['pending', 'running'].includes(job.status) ? `<button class="btn btn-ghost btn-sm" data-job-action="cancel" data-job-id="${escHtml(job.id)}">${t('jobs.cancel')}</button>` : ''}</div></div>`,
            )
            .join('')
        : `<p>${t('jobs.empty')}</p>`;
    } catch (error) {
      if (!signal.aborted) container.textContent = error.message;
    }
    if (!signal.aborted) timer = setTimeout(refresh, state.config.admin?.jobPollMs || 5000);
  };
  container.addEventListener(
    'click',
    async (event) => {
      const button = event.target.closest('[data-job-action]');
      if (!button) return;
      button.disabled = true;
      try {
        await mediaJobs[button.dataset.jobAction](button.dataset.jobId);
        clearTimeout(timer);
        await refresh();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    },
    { signal },
  );
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  refresh();
}
