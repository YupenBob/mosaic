/**
 * Trash page — restored/removed items list (GitHub has no native trash, the
 * API returns an empty list today) plus Deploy legacy redirect page.
 */
import { trash as trashApi } from '../src/api.js';
import { t } from './i18n.js';
import { escHtml, toast, modalConfirm, emptyState } from './ui.js';

export default async function renderTrash() {
  let items = [];
  try {
    items = await trashApi.list();
  } catch {}
  return `
    <div class="page-anim">
      <div class="page-header"><div><h1>${t('trash.title')}</h1></div></div>
      <div class="card">
        ${
          items.length
            ? items
                .map(
                  (item) => `
            <div style="padding:10px 16px;border-bottom:1px solid var(--color-border-light);display:flex;justify-content:space-between;align-items:center;gap:10px">
              <span style="font-size:var(--font-size-sm);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(item.title || item.dir || '')}</span>
              <div style="display:flex;gap:6px;flex-shrink:0">
                <button class="btn btn-secondary btn-sm" onclick="doRestoreTrash('${escHtml(item.dir)}')"><i class="ri-arrow-go-back-line"></i> ${t('trash.restore')}</button>
                <button class="btn btn-danger btn-sm" onclick="doPermanentDelete('${escHtml(item.dir)}')"><i class="ri-delete-bin-line"></i> ${t('trash.permDelete')}</button>
              </div>
            </div>`,
                )
                .join('')
            : emptyState('ri-delete-bin-6-line', t('trash.emptyTitle'), t('trash.emptyDesc'))
        }
      </div>
    </div>
  `;
}

window.doRestoreTrash = async (dir) => {
  try {
    await trashApi.restore(dir);
    location.reload();
  } catch (err) {
    toast(t('trash.restoreFailed') + ': ' + err.message, 'error');
  }
};

window.doPermanentDelete = (dir) => {
  modalConfirm(t('trash.deleteConfirm', { name: dir }), '', async () => {
    try {
      await trashApi.permanentDelete(dir);
      location.reload();
    } catch (err) {
      toast(t('trash.deleteFailed') + ': ' + err.message, 'error');
    }
  });
};

// Legacy #deploy — hidden redirect to the unified build page
export function renderDeployRedirect() {
  setTimeout(() => {
    location.hash = 'build';
  }, 0);
  return `<div class="page-anim" style="padding:60px;text-align:center;color:var(--color-text-tertiary)"><i class="ri-loader-4-line" style="animation:spin 1s linear infinite;font-size:28px"></i><p style="margin-top:12px">${t('common.loading')}</p></div>`;
}

export const trashSkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:100px;height:30px"></div></div>
    <div class="skeleton-card">${[1, 2, 3].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
  </div>
`;
