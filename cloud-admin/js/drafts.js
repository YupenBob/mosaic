/**
 * Cloud drafts index. Drafts are R2 records, separate from published posts;
 * opening one switches the editor into draft mode, where saving updates the
 * draft and publishing writes Git.
 */
import { drafts as draftsApi } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { escHtml, toast, emptyState, formatTime, modalConfirm } from './ui.js?v=1';

export default async function renderDrafts(signal) {
  let drafts = [];
  let failed = false;
  try {
    const result = await draftsApi.list();
    drafts = result.drafts || [];
  } catch {
    failed = true;
  }
  if (signal.aborted) return '';

  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>${t('nav.drafts')}</h1>
            <p class="page-subtitle">${t('drafts.subtitle', { n: drafts.length })}</p>
          </div>
          <div class="page-header-actions">
            <button type="button" class="btn btn-primary" data-new-draft><i class="ri-add-line" aria-hidden="true"></i> ${t('drafts.new')}</button>
          </div>
        </div>
        <div id="drafts-list" class="card"></div>
      </div>
    `,
    onMount() {
      const listEl = document.getElementById('drafts-list');
      const render = () => {
        if (signal.aborted || !listEl) return;
        if (failed) {
          listEl.innerHTML = `<div class="page-load-error" role="alert">${t('drafts.loadFailed')}</div>`;
          return;
        }
        listEl.innerHTML = drafts.length
          ? `<div class="draft-list">${drafts
              .map(
                (draft) => `<div class="draft-row" data-draft-id="${escHtml(draft.id)}">
                  <div class="draft-row-main">
                    <strong>${escHtml(draft.title || draft.slug || t('drafts.untitled'))}</strong>
                    <span>${escHtml(draft.slug || t('drafts.noSlug'))} · ${escHtml(t('drafts.meta', { n: draft.mediaCount || 0 }))}</span>
                  </div>
                  <span class="draft-row-time">${escHtml(formatTime(draft.updatedAt))}</span>
                  <div class="row-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-open-draft="${escHtml(draft.id)}">${t('drafts.continue')}</button>
                    <button type="button" class="icon-btn" data-delete-draft="${escHtml(draft.id)}" aria-label="${t('common.delete')}" title="${t('common.delete')}"><i class="ri-delete-bin-line" aria-hidden="true"></i></button>
                  </div>
                </div>`,
              )
              .join('')}</div>`
          : emptyState(
              'ri-draft-line',
              t('drafts.emptyTitle'),
              t('drafts.emptyDesc'),
              `<button class="btn btn-primary" data-new-draft-inline><i class="ri-add-line"></i> ${t('drafts.new')}</button>`,
            );
      };
      const create = async () => {
        try {
          const draft = await draftsApi.create({ title: '', slug: '', body: '' });
          location.hash = 'editor&draft=' + encodeURIComponent(draft.id);
        } catch (error) {
          toast(t('drafts.createFailed') + ': ' + (error.message || ''), 'error');
        }
      };
      listEl?.addEventListener('click', async (event) => {
        const open = event.target.closest('[data-open-draft]');
        if (open) {
          location.hash = 'editor&draft=' + encodeURIComponent(open.dataset.openDraft);
          return;
        }
        const remove = event.target.closest('[data-delete-draft]');
        if (remove) {
          modalConfirm(t('drafts.deleteTitle'), t('drafts.deleteDesc'), async () => {
            try {
              await draftsApi.delete(remove.dataset.deleteDraft);
              drafts = drafts.filter((draft) => draft.id !== remove.dataset.deleteDraft);
              render();
              toast(t('drafts.deleted'), 'success');
            } catch (error) {
              toast(t('common.deleteFailed') + ': ' + (error.message || ''), 'error');
            }
          });
          return;
        }
        if (event.target.closest('[data-new-draft-inline]')) create();
      });
      document.querySelector('[data-new-draft]')?.addEventListener('click', create);
      render();
    },
  };
}

export const draftsSkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:120px;height:30px"></div></div>
    <div class="skeleton-card">${[1, 2, 3].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
  </div>
`;
