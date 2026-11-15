/** Cloud preview creation and readiness feedback shared by Drafts and the editor. */
import { previews } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { toast } from './ui.js?v=1';

export async function previewDraft(draftId, signal) {
  if (signal.aborted) return;
  let timer = null;
  const stop = () => clearTimeout(timer);
  signal.addEventListener('abort', stop, { once: true });
  const finish = () => signal.removeEventListener('abort', stop);
  let created;
  try {
    created = await previews.create(draftId);
  } catch (error) {
    finish();
    if (!signal.aborted) toast(t('editor.previewFailed') + ': ' + (error.message || ''), 'error');
    return;
  }
  if (signal.aborted) return;
  toast(t('editor.previewBuilding'), 'info', 5000);
  const url = `/api/preview/${created.token}/`;
  const started = Date.now();
  const poll = async () => {
    if (signal.aborted) return;
    try {
      const status = await previews.status(created.previewId);
      if (signal.aborted) return;
      if (status.status === 'ready') {
        finish();
        toast(t('editor.previewReady'), 'success', 20000, {
          label: t('editor.openPreview'),
          onClick: () => window.open(url, '_blank', 'noopener'),
        });
        return;
      }
      if (status.status === 'failed') {
        finish();
        toast(t('editor.previewFailed') + ': ' + (status.error || ''), 'error', 10000);
        return;
      }
      if (Date.now() - started > 5 * 60 * 1000) {
        finish();
        toast(t('editor.previewTimeout'), 'error');
        return;
      }
      timer = setTimeout(poll, 2500);
    } catch {
      if (!signal.aborted) timer = setTimeout(poll, 4000);
    }
  };
  await poll();
}
