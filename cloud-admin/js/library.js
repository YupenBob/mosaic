/**
 * Asset library — Media v2 assets are independent of posts. This first version
 * lists/filters assets and uploads small files through a presigned R2 PUT; the
 * full resumable upload center and asset detail drawer land with P2's UI step.
 */
import { assets } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { escHtml, toast, emptyState, formatTime } from './ui.js?v=1';

const ACTIVE = new Set(['pending', 'running', 'processing']);

function statusBadge(asset) {
  const status = asset.status === 'deleted' ? 'deleted' : asset.status;
  const cls =
    {
      ready: 'badge-success',
      processing: 'badge-warning',
      running: 'badge-warning',
      pending: 'badge-neutral',
      failed: 'badge-danger',
      cancelled: 'badge-neutral',
      superseded: 'badge-neutral',
    }[status] || 'badge-neutral';
  return `<span class="badge ${cls}">${escHtml(t('jobs.' + status) || status)}</span>`;
}

function assetCard(asset) {
  const icon =
    asset.folder === 'videos' ? 'ri-video-line' : asset.folder === 'music' ? 'ri-music-line' : 'ri-image-line';
  return `<article class="asset-card" data-asset-id="${escHtml(asset.id)}">
    <div class="asset-thumb">${asset.published ? `<img src="/api/assets/${encodeURIComponent(asset.id)}/preview" alt="" loading="lazy" onerror="this.style.display='none'" />` : `<i class="${icon}" aria-hidden="true"></i>`}</div>
    <div class="asset-body">
      <strong class="asset-name" title="${escHtml(asset.filename)}">${escHtml(asset.filename)}</strong>
      <span class="asset-meta">${escHtml(asset.folder)} · ${asset.createdAt ? escHtml(formatTime(asset.createdAt)) : ''}</span>
    </div>
    <div class="asset-status">${statusBadge(asset)}</div>
  </article>`;
}

export default async function renderLibrary(signal) {
  let assetsData = [];
  try {
    const result = await assets.list({});
    assetsData = result.assets || [];
  } catch {}
  if (signal.aborted) return '';

  const active = assetsData.filter((asset) => ACTIVE.has(asset.status)).length;
  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>${t('nav.library')}</h1>
            <p class="page-subtitle">${t('library.subtitle', { total: assetsData.length, active })}</p>
          </div>
          <div class="page-header-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-library-refresh><i class="ri-refresh-line" aria-hidden="true"></i> ${t('common.refresh')}</button>
            <button type="button" class="btn btn-primary" data-library-upload><i class="ri-upload-2-line" aria-hidden="true"></i> ${t('library.upload')}</button>
            <input type="file" id="library-file-input" multiple accept="image/*,video/*,audio/*" hidden />
          </div>
        </div>
        <div class="toolbar-row">
          <div class="task-filters" role="group" aria-label="${t('library.filter')}">
            <button type="button" class="task-filter-btn active" data-asset-filter="all">${t('tasks.all')}</button>
            <button type="button" class="task-filter-btn" data-asset-filter="active">${t('tasks.active')}</button>
            <button type="button" class="task-filter-btn" data-asset-filter="failed">${t('tasks.failed')}</button>
          </div>
          <span class="search-count" id="library-count"></span>
        </div>
        <div id="asset-grid" class="asset-grid" role="status" aria-live="polite"></div>
      </div>
    `,
    onMount() {
      let list = assetsData;
      let filter = 'all';
      let timer = null;

      const visible = () => {
        if (filter === 'active') return list.filter((asset) => ACTIVE.has(asset.status));
        if (filter === 'failed') return list.filter((asset) => asset.status === 'failed');
        return list;
      };

      const render = () => {
        if (signal.aborted) return;
        const grid = document.getElementById('asset-grid');
        if (!grid) return;
        const items = visible();
        const count = document.getElementById('library-count');
        if (count) count.textContent = t('library.count', { n: items.length });
        grid.innerHTML = items.length
          ? items.map(assetCard).join('')
          : emptyState('ri-hard-drive-3-line', t('library.emptyTitle'), t('library.emptyDesc'));
      };

      const load = async () => {
        try {
          const result = await assets.list({});
          if (signal.aborted) return;
          list = result.assets || [];
          const subtitle = document.querySelector('.page-subtitle');
          if (subtitle)
            subtitle.textContent = t('library.subtitle', {
              total: list.length,
              active: list.filter((asset) => ACTIVE.has(asset.status)).length,
            });
          render();
        } catch (error) {
          if (!signal.aborted) toast(t('library.loadFailed') + ': ' + (error.message || ''), 'error');
        }
      };

      const schedule = () => {
        clearTimeout(timer);
        if (signal.aborted) return;
        timer = setTimeout(
          async () => {
            await load();
            schedule();
          },
          list.some((asset) => ACTIVE.has(asset.status)) ? 4000 : 30000,
        );
      };

      const upload = async (files) => {
        const input = document.getElementById('library-file-input');
        for (const file of files) {
          try {
            toast(t('library.uploading', { name: file.name }), 'info', 2500);
            const created = await assets.create({
              filename: file.name,
              size: file.size,
              contentType: file.type || 'application/octet-stream',
            });
            if (!created?.assetId || !created.url) throw new Error(t('library.uploadUnsupported'));
            const response = await fetch(created.url, {
              method: 'PUT',
              body: file,
              headers: { 'Content-Type': file.type || 'application/octet-stream' },
            });
            if (!response.ok) throw new Error(`R2 ${response.status}`);
            await assets.complete(created.assetId, { filename: file.name });
            toast(t('library.uploaded', { name: file.name }), 'success');
          } catch (error) {
            toast(t('library.uploadFailed', { name: file.name }) + ': ' + (error.message || ''), 'error');
          }
        }
        if (input) input.value = '';
        await load();
      };

      document.querySelector('[data-library-refresh]')?.addEventListener('click', () => load());
      document.querySelector('[data-library-upload]')?.addEventListener('click', () => {
        document.getElementById('library-file-input')?.click();
      });
      document.getElementById('library-file-input')?.addEventListener('change', (event) => {
        upload([...(event.target.files || [])]);
      });
      document.querySelectorAll('[data-asset-filter]').forEach((button) => {
        button.addEventListener('click', () => {
          filter = button.dataset.assetFilter;
          document.querySelectorAll('[data-asset-filter]').forEach((item) => {
            item.classList.toggle('active', item === button);
          });
          render();
        });
      });
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
        },
        { once: true },
      );
      render();
      schedule();
    },
  };
}

export const librarySkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:130px;height:30px"></div></div>
    <div class="asset-grid">${[1, 2, 3].map(() => '<div class="skeleton-card"><div class="skeleton skeleton-chart"></div></div>').join('')}</div>
  </div>
`;
