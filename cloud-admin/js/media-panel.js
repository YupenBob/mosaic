/**
 * Editor media panel — renders the existing-media grid with processing status,
 * source-file availability and per-video / per-post 后补帧 actions.
 *
 * Extracted from editor.js so the editor keeps its focus on content editing.
 * `editor.js` registers a hook to re-render inserted media blocks after a
 * refresh; upload.js calls `window.loadExistingMedia` after a confirmed upload.
 */
import { media as mediaApi, mediaJobs } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=1';
import { escHtml, toast, modalConfirm } from './ui.js?v=1';
import {
  canInterpolate,
  ensureInterpolationSupport,
  interpolatePost,
  interpolateVideo,
  isDecodedVideo,
  isSourceMissing,
} from './interpolate.js?v=1';

let mediaRefreshTimer = null;
let hooks = {};

/** Editor registers callbacks used when the media list refreshes. */
export function setMediaPanelHooks(nextHooks) {
  hooks = nextHooks || {};
}

function currentSlug() {
  return document.getElementById('fm-slug')?.value || '';
}

function placeholderFor(type, index) {
  return type === 'photo' ? `{{photo:${index}}}` : type === 'video' ? `{{video:${index}}}` : '{{music}}';
}

/** Post-hoc interpolation button state (tooltip changes when unsupported). */
function interpolationButton(item, slug) {
  if (!isDecodedVideo(item)) return '';
  const enabled = canInterpolate();
  const title = enabled ? t('interpolate.actionHint') : t('interpolate.unsupportedHint');
  return `<button type="button" class="media-cell-tool" data-interp-video="${escHtml(item.name)}" data-slug="${escHtml(slug)}" data-name="${escHtml(item.name)}" aria-label="${t('interpolate.action')} ${escHtml(item.name)}" title="${escHtml(title)}"${enabled ? '' : ' disabled'}><i class="ri-timer-flash-line" aria-hidden="true"></i><span>${t('interpolate.action')}</span></button>`;
}

function sourceBadge(item) {
  if (!isSourceMissing(item)) return '';
  return `<span class="media-cell-warning" title="${escHtml(t('jobs.sourceDeletedHint'))}"><i class="ri-error-warning-line" aria-hidden="true"></i>${t('jobs.sourceDeleted')}</span>`;
}

function taskOptions(item) {
  const options = item.options || {};
  if (!options.interpolation?.enabled && typeof options.keepSource !== 'boolean') return '';
  const parts = [];
  if (options.interpolation?.enabled) parts.push(`${t('jobs.interpolation')} ${options.interpolation.fps || 60}fps`);
  if (options.keepSource === false) parts.push(t('jobs.deleteSource'));
  else if (options.keepSource === true) parts.push(t('jobs.keepSource'));
  return parts.length ? `<span class="media-cell-options">${escHtml(parts.join(' · '))}</span>` : '';
}

/**
 * One media cell. Video cells get 后补帧 and source-deleted affordances.
 * @param {'photo'|'video'|'music'} type
 * @param {object} file Media item from `/api/media/:slug/list`.
 * @param {number} index Index for `{{video:n}}` placeholders.
 * @param {string} slug Post slug.
 */
function mediaCell(type, file, index, slug) {
  const placeholder = placeholderFor(type, index);
  const inner =
    type === 'photo'
      ? `<img src="${escHtml(file.previewUrl || file.url || '')}" alt="${escHtml(file.name)}" loading="lazy" />`
      : `<div class="media-cell-icon"><i class="ri-${type === 'video' ? 'video' : 'music'}-line" aria-hidden="true"></i></div>`;
  const activate =
    type === 'photo'
      ? `onclick="window.pickCover('${escHtml(file.name)}')"`
      : `onclick="window.insertPlaceholder('${escHtml(placeholder)}')"`;
  const tools = type === 'video' ? interpolationButton(file, slug) : '';
  return `
    <div class="media-cell" ${activate} draggable="true" data-ph="${escHtml(placeholder)}" title="${escHtml(file.name)} — ${t('editor.dragInsertHint')}">
      ${inner}
      <div class="media-cell-name">${escHtml(file.name)}</div>
      ${file.status ? `<span class="media-cell-status">${escHtml(t('jobs.' + file.status))}${file.published && file.status !== 'ready' ? ' · ' + t('jobs.previous') : ''}</span>` : ''}
      ${sourceBadge(file)}
      ${taskOptions(file)}
      ${tools ? `<div class="media-cell-tools">${tools}</div>` : ''}
      ${file.taskId && ['failed', 'cancelled'].includes(file.status) ? `<button type="button" class="btn btn-ghost btn-sm media-cell-retry" onclick="event.stopPropagation();window.retryEditorMedia('${escHtml(file.taskId)}')"><i class="ri-refresh-line" aria-hidden="true"></i> ${t('jobs.retry')}</button>` : ''}
      <button type="button" class="media-cell-insert" onclick="event.stopPropagation();window.insertPlaceholder('${escHtml(placeholder)}')" title="${t('editor.insert')}" aria-label="${t('editor.insert')} ${escHtml(file.name)}"><i class="ri-corner-down-left-line" aria-hidden="true"></i></button>
      <button class="media-cell-del" onclick="event.stopPropagation();doDeleteMedia('${escHtml(slug)}','${escHtml(file.name)}','${type}s')" title="${t('editor.deleteMedia')}" aria-label="${t('editor.deleteMedia')}"><i class="ri-delete-bin-line" aria-hidden="true"></i></button>
    </div>`;
}

/** Group heading with an optional batch action (e.g. 全部后补帧). */
function mediaGroup(title, count, insertPlaceholder, cellsHtml, extraAction = '') {
  return `
    <div class="media-group-head">
      <span class="editor-section-title" style="margin:0">${title} (${count})</span>
      <span class="media-group-actions">
        ${extraAction}
        <button type="button" class="btn btn-ghost btn-sm" onclick="window.insertPlaceholder('${escHtml(insertPlaceholder)}')">${t('editor.insertAll')}</button>
      </span>
    </div>
    ${cellsHtml}`;
}

/** Skeleton shown on the very first load (no layout jump later). */
function mediaSkeleton() {
  return `<div class="media-skeleton" role="status" aria-label="${t('common.loading')}">
    ${[1, 2].map(() => '<div class="media-skeleton-cell"><div class="skeleton skeleton-box"></div><div class="skeleton skeleton-line"></div></div>').join('')}
  </div>`;
}

/**
 * Load and render the media list for a post.
 * @param {string} slug Post slug.
 */
export async function loadExistingMedia(slug) {
  clearTimeout(mediaRefreshTimer);
  const el = document.getElementById('existing-media');
  if (!el) return;
  const signal = state.pageScope?.signal;
  if (!el.querySelector('.media-grid')) el.innerHTML = mediaSkeleton();

  // Resolve interpolation support in parallel; the optimistic config check
  // renders immediately and the probe only patches button state afterwards.
  const supportPromise = ensureInterpolationSupport();
  const syncButtons = () => {
    if (signal?.aborted) return;
    const enabled = canInterpolate();
    el.querySelectorAll('[data-interp-video]').forEach((button) => {
      button.disabled = !enabled;
      button.title = enabled ? t('interpolate.actionHint') : t('interpolate.unsupportedHint');
    });
  };

  try {
    const data = await mediaApi.list(slug);
    if (signal?.aborted || !el.isConnected || slug !== currentSlug()) return;
    await Promise.race([supportPromise, new Promise((resolve) => setTimeout(resolve, 1500))]);
    if (signal?.aborted || !el.isConnected) return;
    const photos = data.photos || [];
    const videos = data.videos || [];
    const music = data.music || [];
    const covers = data.covers || [];
    const decodedVideos = videos.filter(isDecodedVideo).length;
    state.editor.media = { photos, videos, music, covers };

    let html = `<div class="editor-section-title">${t('editor.existingMedia')}</div>`;
    if (!photos.length && !videos.length && !music.length && !covers.length) {
      html += `<p class="media-empty">${t('editor.noMedia')}</p>`;
    } else {
      if (photos.length) {
        html += mediaGroup(
          t('editor.photos'),
          photos.length,
          '{{gallery}}',
          `<div class="media-grid">${photos.map((file, index) => mediaCell('photo', file, index, slug)).join('')}</div>`,
        );
      }
      if (videos.length) {
        const batch =
          decodedVideos > 0 && canInterpolate()
            ? `<button type="button" class="btn btn-ghost btn-sm media-group-interp" data-interp-post data-slug="${escHtml(slug)}" data-count="${decodedVideos}"><i class="ri-timer-flash-line" aria-hidden="true"></i> ${t('interpolate.postAction')}</button>`
            : '';
        html += mediaGroup(
          t('editor.placeholderVideos'),
          videos.length,
          '{{videos}}',
          `<div class="media-grid" style="margin-top:8px">${videos.map((file, index) => mediaCell('video', file, index, slug)).join('')}</div>`,
          batch,
        );
      }
      if (music.length) {
        html += mediaGroup(
          t('editor.music'),
          music.length,
          '{{music}}',
          `<div class="media-grid" style="margin-top:8px">${music.map((file, index) => mediaCell('music', file, index, slug)).join('')}</div>`,
        );
      }
      if (covers.length)
        html += `<div class="editor-section-title">${t('editor.cover')}</div><div class="media-grid">${covers.map((file) => `<button type="button" class="media-cell" onclick="window.pickCover('${escHtml(file.name)}')"><img src="${escHtml(file.previewUrl || file.url)}" alt="${escHtml(file.name)}" loading="lazy" /><span class="media-cell-name">${escHtml(file.name)}</span></button>`).join('')}</div>`;
    }
    el.innerHTML = html;
    wireMediaActions(el, signal);
    supportPromise.then(syncButtons);
    syncButtons();
    window.updateCoverPreview?.();
    const firstRender = !el.dataset.loaded;
    hooks.onMediaUpdated?.(firstRender);
    el.dataset.loaded = 'true';

    if (
      [...photos, ...videos, ...music, ...covers].some((item) =>
        ['pending', 'running', 'processing'].includes(item.status),
      )
    ) {
      mediaRefreshTimer = setTimeout(() => {
        if (!signal?.aborted) loadExistingMedia(slug);
      }, state.config.admin?.jobPollMs || 5000);
    }
  } catch {
    if (signal?.aborted || !el.isConnected) return;
    el.innerHTML = `<div class="media-load-error" role="alert"><i class="ri-error-warning-line" aria-hidden="true"></i><span>${t('editor.loadError')}</span><button type="button" class="btn btn-secondary btn-sm" data-media-retry><i class="ri-refresh-line" aria-hidden="true"></i> ${t('common.retry')}</button></div>`;
    el.querySelector('[data-media-retry]')?.addEventListener('click', () => loadExistingMedia(slug), { signal });
  }
}

/** Delegated actions inside the media grid (registered once per element). */
const wiredRoots = new WeakSet();
function wireMediaActions(root, signal) {
  if (wiredRoots.has(root)) return;
  wiredRoots.add(root);
  // Capture phase: the interpolation button lives inside a `.media-cell` whose
  // inline onclick inserts a placeholder, so the action must be intercepted
  // before it bubbles to the cell (otherwise 后补帧 would edit the body).
  root.addEventListener(
    'click',
    async (event) => {
      const videoButton = event.target.closest('[data-interp-video]');
      if (videoButton) {
        event.preventDefault();
        event.stopPropagation();
        if (!canInterpolate()) return;
        await interpolateVideo({
          slug: videoButton.dataset.slug,
          filename: videoButton.dataset.interpVideo,
          name: videoButton.dataset.name,
        });
        clearTimeout(mediaRefreshTimer);
        mediaRefreshTimer = setTimeout(() => loadExistingMedia(videoButton.dataset.slug), 800);
        return;
      }
      const postButton = event.target.closest('[data-interp-post]');
      if (postButton) {
        event.preventDefault();
        event.stopPropagation();
        if (!canInterpolate()) return;
        await interpolatePost({ slug: postButton.dataset.slug, count: Number(postButton.dataset.count) || 0 });
        clearTimeout(mediaRefreshTimer);
        mediaRefreshTimer = setTimeout(() => loadExistingMedia(postButton.dataset.slug), 800);
      }
    },
    { capture: true, signal },
  );
}

// ── Globals used by editor markup / upload.js ─
window.loadExistingMedia = loadExistingMedia;

window.retryEditorMedia = async (id) => {
  try {
    await mediaJobs.retry(id);
    await loadExistingMedia(currentSlug());
  } catch (error) {
    toast(error.message, 'error');
  }
};

window.doDeleteMedia = (slug, file, type) => {
  modalConfirm(t('editor.mediaDeleteConfirm', { file }), t('common.permDeleteConfirm', { name: file }), async () => {
    try {
      await mediaApi.delete(slug, file, type);
      window.checkDirty && window.checkDirty();
      await loadExistingMedia(slug);
      toast(t('editor.mediaDeleted', { file }), 'success');
    } catch (err) {
      toast(t('common.deleteFailed') + ': ' + err.message, 'error', 8000, {
        label: t('common.retry'),
        onClick: () => window.doDeleteMedia(slug, file, type),
      });
    }
  });
};
