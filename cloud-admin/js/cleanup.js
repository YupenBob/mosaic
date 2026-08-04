/**
 * Cleanup page — orphan file cleanup + processed cache cleanup with
 * indeterminate progress, copy-path actions and typed confirmation.
 */
import { getToken } from '../src/api.js';
import { t } from './i18n.js';
import { escHtml, modalConfirm, copyText, fmtSize } from './ui.js';

export default async function renderCleanup() {
  const API = window.__API_BASE__ || '/api';
  const hp = { Authorization: 'Bearer ' + (getToken() || '') };
  try {
    const data = await fetch(API + '/cleanup', { headers: hp }).then((r) => r.json());
    const orphans = data.orphans || [];
    const total = (data.totalSize / 1048576).toFixed(1);
    window._orphanCount = data.totalOrphans || 0;
    return `
      <div class="page-anim">
        <div class="page-header"><div><h1>${t('cleanup.title')}</h1></div></div>

        <div class="card card-pad mb-4">
          <h3 style="margin-bottom:6px"><i class="ri-delete-bin-line" style="color:var(--color-danger)"></i> ${t('cleanup.orphan')}</h3>
          <p class="muted mb-3">${t('cleanup.orphanDesc')}</p>
          <div class="cleanup-stat-row">
            <div class="dash-big-card"><span class="dash-big-num">${data.totalOrphans || 0}</span><span class="dash-big-label">${t('cleanup.orphanFiles')}</span></div>
            <div class="dash-big-card"><span class="dash-big-num">${total} MB</span><span class="dash-big-label">${t('cleanup.wastedSpace')}</span></div>
          </div>
          ${
            orphans.length
              ? `
            <div class="cleanup-actions">
              <button class="btn btn-danger" id="btn-cleanup" onclick="doCleanup()"><i class="ri-delete-bin-line"></i> ${t('cleanup.deleteOrphans')}</button>
              <span class="muted">${orphans.length} ${t('cleanup.files')}</span>
            </div>
            <div class="file-list" style="max-height:260px;overflow-y:auto">
              ${orphans
                .slice(0, 50)
                .map(
                  (o) => `
                <div class="file-row">
                  <i class="ri-file-line" style="color:var(--color-text-tertiary)"></i>
                  <code>${escHtml(o.key)}</code>
                  <span class="file-size">${fmtSize(o.size)}</span>
                  <button class="btn btn-ghost btn-sm" onclick="copyCleanupPath('${escHtml(o.key)}')" title="${t('cleanup.copyPath')}" aria-label="${t('cleanup.copyPath')}"><i class="ri-file-copy-line"></i></button>
                </div>`,
                )
                .join('')}
              ${orphans.length > 50 ? `<div class="file-row muted">${t('cleanup.more', { n: orphans.length - 50 })}</div>` : ''}
            </div>
          `
              : `<p class="text-success" style="padding:10px 0;font-size:13px"><i class="ri-check-line"></i> ${t('cleanup.noOrphans')}</p>`
          }
        </div>

        <div class="card card-pad">
          <h3 style="margin-bottom:6px"><i class="ri-refresh-line" style="color:var(--color-accent)"></i> ${t('cleanup.cacheCleanup')}</h3>
          <p class="muted mb-3">${t('cleanup.cacheDesc')}</p>
          <button class="btn btn-danger" id="btn-clear-cache" onclick="doClearCache()"><i class="ri-delete-bin-line"></i> ${t('cleanup.clearCache')}</button>
        </div>

        <div id="cleanup-progress" style="display:none;margin-top:14px"></div>
      </div>
    `;
  } catch (e) {
    return `<div class="page-anim"><h1>${t('cleanup.title')}</h1><p class="error">${escHtml(e.message)}</p></div>`;
  }
}

function showIndeterminate(text) {
  const progress = document.getElementById('cleanup-progress');
  if (!progress) return;
  progress.style.display = 'block';
  progress.innerHTML = `
    <div class="card card-pad">
      <div class="progress-bar"><div class="progress-fill" style="width:100%;animation:pulse 1.4s infinite"></div></div>
      <p class="cleanup-progress-note"><span class="spinner"></span> ${escHtml(text)}</p>
    </div>`;
}

window.doCleanup = () => {
  const n = window._orphanCount || 0;
  modalConfirm(
    t('cleanup.confirmOrphan'),
    t('cleanup.confirmOrphanDesc', { n }),
    async () => {
      const API = window.__API_BASE__ || '/api';
      const hp = { Authorization: 'Bearer ' + (getToken() || '') };
      const btn = document.getElementById('btn-cleanup');
      if (btn) btn.style.display = 'none';
      showIndeterminate(t('cleanup.deleting'));
      try {
        const result = await fetch(API + '/cleanup', { method: 'DELETE', headers: hp }).then((r) => r.json());
        if (result.error) {
          showResult(t('common.error') + ': ' + result.error, true);
          return;
        }
        showResult(t('common.deleted', { count: result.deleted, size: result.freedMB + ' MB' }), false);
        setTimeout(() => {
          location.reload();
        }, 1600);
      } catch (e) {
        showResult(e.message, true);
      }
    },
    { requireText: n > 0 ? String(n) : null },
  );
};

window.doClearCache = () => {
  modalConfirm(
    t('cleanup.confirmCache'),
    t('cleanup.confirmCacheDesc'),
    async () => {
      const API = window.__API_BASE__ || '/api';
      const hp = { Authorization: 'Bearer ' + (getToken() || '') };
      const btn = document.getElementById('btn-clear-cache');
      if (btn) btn.style.display = 'none';
      showIndeterminate(t('cleanup.deletingCache'));
      try {
        const result = await fetch(API + '/processed-cache', { method: 'DELETE', headers: hp }).then((r) => r.json());
        if (result.error) {
          showResult(t('common.error') + ': ' + result.error, true);
          return;
        }
        showResult(t('common.deleted', { count: result.deleted, size: result.freedMB + ' MB' }), false);
        setTimeout(() => {
          location.reload();
        }, 1600);
      } catch (e) {
        showResult(e.message, true);
      }
    },
    { requireText: 'cache' },
  );
};

function showResult(msg, isError) {
  const progress = document.getElementById('cleanup-progress');
  if (!progress) return;
  progress.style.display = 'block';
  progress.innerHTML = `<div class="card card-pad cleanup-result" style="color:${isError ? 'var(--color-danger)' : 'var(--color-success)'}"><i class="${isError ? 'ri-close-circle-line' : 'ri-check-circle-line'}"></i> ${escHtml(msg)}</div>`;
}

window.copyCleanupPath = (key) => copyText(key);

export const cleanupSkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:110px;height:30px"></div></div>
    <div class="skeleton-card"><div class="skeleton skeleton-line w40" style="height:18px;margin-bottom:8px"></div><div class="skeleton skeleton-line" style="margin-bottom:12px"></div><div class="cleanup-stat-row"><div class="skeleton-box"></div><div class="skeleton-box"></div></div></div>
    <div class="skeleton-card"><div class="skeleton skeleton-line w40" style="height:18px;margin-bottom:8px"></div><div class="skeleton skeleton-line"></div></div>
  </div>
`;
