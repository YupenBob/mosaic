/**
 * Editor page — three-pane post editor with Markdown preview, autosave
 * drafts, cover picker, stats section and the media panel.
 */
import {
  posts as postsApi,
  media as mediaApi,
  assets as assetsApi,
  drafts as draftsApi,
  previews as previewsApi,
} from '../src/api.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=1';
import { escHtml, toast, loadLib, openModal, closeModal } from './ui.js?v=1';
import { loadExistingMedia, setMediaPanelHooks } from './media-panel.js?v=1';
import { jsStr } from './escape.js';

const MARKED_URL = 'js/vendor/marked.min.js';
const PURIFY_URL = 'js/vendor/purify.min.js';
const PLACEHOLDER_RE = /^\s*\{\{(gallery|videos|music|video:(\d+)|photo:(\d+))\}\}\s*$/;
const BLOCK_DRAG_PREFIX = '__mosaic_block:';
let editorBlocks = [];
let previewVisible = false;
let previewTimer = null;
let cloudDraftTimer = null;
let cloudDraftBusy = false;
let previewPollTimer = null;

function getEditorMedia() {
  const refs = state.editor.mediaRefs;
  if (refs && refsIds(refs).length) {
    const view = (id) => {
      const asset = state.editor.assetCache?.[id];
      if (!asset) return null;
      return {
        name: asset.filename,
        previewUrl: assetPreview(asset),
        url: asset.previewUrl || assetPreview(asset),
        status: asset.status,
        published: asset.published,
      };
    };
    const photos = (refs.gallery || []).map(view).filter(Boolean);
    const videos = (refs.videos || []).map(view).filter(Boolean);
    const music = (refs.music || []).map(view).filter(Boolean);
    const covers = refs.cover ? [view(refs.cover)].filter(Boolean) : [];
    if (photos.length || videos.length || music.length || covers.length) return { photos, videos, music, covers };
  }
  return state.editor.media || { photos: [], videos: [], music: [] };
}

// Parse the markdown body into editor blocks (mirrors scripts/blocks.mjs:
// standalone placeholders surrounded by blank lines become media blocks;
// out-of-range photo:N / video:N stay literal; unplaced media stay unplaced).
function parseBodyBlocks(body) {
  const lines = String(body || '').split(/\r?\n/);
  const blocks = [];
  let buf = [];
  const flushText = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (text) blocks.push({ type: 'text', text });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = PLACEHOLDER_RE.exec(line);
    const prevBlank = i === 0 || !lines[i - 1].trim();
    const nextBlank = i === lines.length - 1 || !lines[i + 1].trim();
    if (m && prevBlank && nextBlank) {
      const raw = m[1];
      const idx = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number(m[3]) : null;
      const kind = raw.split(':')[0];
      const media = getEditorMedia();
      if ((kind === 'video' && !(media.videos || [])[idx]) || (kind === 'photo' && !(media.photos || [])[idx])) {
        buf.push(line);
        continue;
      }
      flushText();
      blocks.push({ type: kind, raw, index: idx });
    } else {
      buf.push(line);
    }
  }
  flushText();
  if (!blocks.length) blocks.push({ type: 'text', text: '' });
  return blocks;
}

function serializeBlocks(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      if (b.text.trim()) parts.push(b.text.trim());
    } else {
      parts.push('{{' + b.raw + '}}');
    }
  }
  const body = parts.join('\n\n');
  return body ? body + '\n' : '';
}

function syncBodyFromBlocks() {
  const ta = document.getElementById('fm-body');
  if (!ta) return;
  const body = serializeBlocks(editorBlocks);
  if (ta.value !== body) {
    ta.value = body;
    ta.dispatchEvent(new Event('input'));
  }
  schedulePreview();
}

// Live preview for split/preview modes: debounce re-render on every body change.
function schedulePreview() {
  if (!previewVisible) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 180);
}

function mediaRow(name, icon) {
  return `<div class="fm-media-row"><i class="${icon}"></i><span>${escHtml(name)}</span></div>`;
}

function mediaRows(names, icon) {
  if (!names.length) return `<p class="muted">0</p>`;
  return `<div class="fm-media-rows">${names.map((n) => mediaRow(n, icon)).join('')}</div>`;
}

function mediaBlockHtml(b, media) {
  if (b.type === 'gallery') {
    const items = media.photos || [];
    const thumbs = items
      .slice(0, 8)
      .map((f) => `<img src="${escHtml(f.previewUrl || f.url || '')}" alt="" loading="lazy" />`)
      .join('');
    const more = items.length > 8 ? `<span class="fm-media-more">+${items.length - 8}</span>` : '';
    return items.length ? `<div class="fm-media-gallery">${thumbs}${more}</div>` : `<p class="muted">0</p>`;
  }
  if (b.type === 'photo') {
    const item = (media.photos || [])[b.index];
    return item
      ? `<img class="fm-media-single" src="${escHtml(item.previewUrl || item.url || '')}" alt="" loading="lazy" />`
      : '';
  }
  if (b.type === 'videos')
    return mediaRows(
      (media.videos || []).map((f) => f.name),
      'ri-video-line',
    );
  if (b.type === 'video') {
    const item = (media.videos || [])[b.index];
    return item ? mediaRow(item.name, 'ri-video-line') : '';
  }
  return mediaRows(
    (media.music || []).map((f) => f.name),
    'ri-music-2-line',
  );
}

function blockMediaIcon(type) {
  if (type === 'photo' || type === 'gallery') return 'image-line';
  if (type === 'video' || type === 'videos') return 'video-line';
  return 'music-2-line';
}

function blockActionsHtml() {
  return `
    <div class="fm-block-actions">
      <span class="fm-block-drag" role="button" tabindex="0" draggable="true" title="${t('editor.blockDrag')}" aria-label="${t('editor.blockDrag')}"><i class="ri-drag-move-2-line"></i></span>
      <button type="button" class="fm-block-btn" data-act="up" title="${t('editor.blockUp')}" aria-label="${t('editor.blockUp')}"><i class="ri-arrow-up-line"></i></button>
      <button type="button" class="fm-block-btn" data-act="down" title="${t('editor.blockDown')}" aria-label="${t('editor.blockDown')}"><i class="ri-arrow-down-line"></i></button>
      <button type="button" class="fm-block-btn fm-block-btn-danger" data-act="remove" title="${t('editor.blockRemove')}" aria-label="${t('editor.blockRemove')}"><i class="ri-close-line"></i></button>
    </div>`;
}

function blockHtml(b, i, media) {
  if (b.type === 'text') {
    return `
      <div class="fm-block fm-text-block-wrap" data-index="${i}">
        <textarea class="fm-text-block" aria-label="${t('editor.blockTextLabel')} ${i + 1}" spellcheck="false" placeholder="${t('editor.blockTextLabel')}">${escHtml(b.text)}</textarea>
        ${blockActionsHtml()}
      </div>`;
  }
  return `
    <div class="fm-block fm-media-block" data-index="${i}" data-raw="${escHtml(b.raw)}">
      <div class="fm-block-label"><i class="ri-${blockMediaIcon(b.type)}"></i> {{${escHtml(b.raw)}}}</div>
      <div class="fm-block-media">${mediaBlockHtml(b, media)}</div>
      ${blockActionsHtml()}
    </div>`;
}

function unplacedHint(media) {
  const parts = [];
  if (media.photos.length) parts.push(`${t('editor.photos')}×${media.photos.length}`);
  if (media.videos.length) parts.push(`${t('editor.placeholderVideos')}×${media.videos.length}`);
  if (media.music.length) parts.push(`${t('editor.music')}×${media.music.length}`);
  if (!parts.length) return '';
  return `<p class="unplaced-hint"><i class="ri-information-line"></i> ${t('editor.unplacedMedia')} ${parts.join('、')}</p>`;
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.max(60, ta.scrollHeight) + 'px';
}

function renderBlocksInto(container) {
  const media = getEditorMedia();
  container.innerHTML = editorBlocks.map((b, i) => blockHtml(b, i, media)).join('') + unplacedHint(media);
  container.querySelectorAll('.fm-text-block').forEach((ta) => autoGrow(ta));
}

function renderBlocksFromBody() {
  const container = document.getElementById('fm-blocks');
  const ta = document.getElementById('fm-body');
  if (!container || !ta) return;
  editorBlocks = parseBodyBlocks(ta.value);
  renderBlocksInto(container);
}

function refreshBlockMedia() {
  // Background media updates must preserve the active text node, cursor and undo history.
  document.querySelectorAll('#fm-blocks .fm-media-block').forEach((element) => {
    const block = editorBlocks[Number(element.dataset.index)];
    if (block) element.querySelector('.fm-block-media').innerHTML = mediaBlockHtml(block, getEditorMedia());
  });
  schedulePreview();
}

function commitBlocks() {
  syncBodyFromBlocks();
  renderBlocksInto(document.getElementById('fm-blocks'));
}

function moveBlock(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= editorBlocks.length) return;
  [editorBlocks[i], editorBlocks[j]] = [editorBlocks[j], editorBlocks[i]];
  commitBlocks();
}

function removeBlock(i) {
  editorBlocks.splice(i, 1);
  if (!editorBlocks.length) editorBlocks.push({ type: 'text', text: '' });
  commitBlocks();
}

function insertMediaBlock(ph, at) {
  const m = PLACEHOLDER_RE.exec(ph);
  if (!m) return;
  const media = getEditorMedia();
  const raw = m[1];
  const idx = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number(m[3]) : null;
  const kind = raw.split(':')[0];
  if ((kind === 'video' && !(media.videos || [])[idx]) || (kind === 'photo' && !(media.photos || [])[idx])) {
    toast(
      t('editor.placeholderOutOfRange', {
        n: kind === 'video' ? (media.videos || []).length : (media.photos || []).length,
      }),
      'error',
    );
    return;
  }
  const pos = Math.max(0, Math.min(at, editorBlocks.length));
  editorBlocks.splice(pos, 0, { type: kind, raw, index: idx });
  commitBlocks();
}

window.insertPlaceholder = (ph) => {
  insertMediaBlock(ph.trim(), editorBlocks.length);
};

function blockIndexFromPoint(y) {
  const els = [...document.querySelectorAll('#fm-blocks .fm-block')];
  for (let i = 0; i < els.length; i++) {
    const r = els[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return els.length;
}

function showDropLine(y) {
  const container = document.getElementById('fm-blocks');
  if (!container) return;
  let line = container.querySelector('.fm-drop-line');
  if (!line) {
    line = document.createElement('div');
    line.className = 'fm-drop-line';
    container.appendChild(line);
  }
  const els = [...container.querySelectorAll('.fm-block')];
  const at = blockIndexFromPoint(y);
  const top =
    at < els.length
      ? els[at].offsetTop
      : els.length
        ? els[els.length - 1].offsetTop + els[els.length - 1].offsetHeight
        : 0;
  line.style.top = top + 'px';
  line.style.display = 'block';
}

function hideDropLine() {
  const line = document.getElementById('fm-blocks')?.querySelector('.fm-drop-line');
  if (line) line.style.display = 'none';
}

function wireBodyDnD() {
  const container = document.getElementById('fm-blocks');
  const panel = document.getElementById('existing-media');
  if (!container || !panel) return;
  // Capture phase so the browser's built-in text-drop on the textarea never
  // takes over: block reordering must win over inserting dragged text.
  container.addEventListener(
    'dragover',
    (e) => {
      if (!e.dataTransfer || !(e.dataTransfer.types || []).includes('text/plain')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      showDropLine(e.clientY);
    },
    true,
  );
  container.addEventListener(
    'dragleave',
    (e) => {
      if (!container.contains(e.relatedTarget)) hideDropLine();
    },
    true,
  );
  container.addEventListener(
    'drop',
    (e) => {
      hideDropLine();
      const text = ((e.dataTransfer && e.dataTransfer.getData('text/plain')) || '').trim();
      const at = blockIndexFromPoint(e.clientY);
      if (text.startsWith(BLOCK_DRAG_PREFIX)) {
        const from = Number(text.slice(BLOCK_DRAG_PREFIX.length));
        if (Number.isFinite(from) && editorBlocks[from]) {
          const [moved] = editorBlocks.splice(from, 1);
          const insertAt = from < at ? at - 1 : at;
          editorBlocks.splice(Math.max(0, Math.min(insertAt, editorBlocks.length)), 0, moved);
          commitBlocks();
          e.preventDefault();
        }
        return;
      }
      if (/^\{\{(gallery|videos|music|video:\d+|photo:\d+)\}\}$/.test(text)) {
        e.preventDefault();
        insertMediaBlock(text, at);
      }
    },
    true,
  );
  container.addEventListener(
    'dragstart',
    (e) => {
      const handle = e.target.closest('.fm-block-drag');
      if (!handle) return;
      const i = Number(handle.closest('.fm-block')?.dataset.index);
      if (!Number.isFinite(i)) return;
      e.dataTransfer.setData('text/plain', BLOCK_DRAG_PREFIX + i);
      e.dataTransfer.effectAllowed = 'move';
    },
    true,
  );
  container.addEventListener('input', (e) => {
    const ta = e.target.closest('.fm-text-block');
    if (!ta) return;
    const i = Number(ta.closest('.fm-text-block-wrap')?.dataset.index);
    if (Number.isFinite(i) && editorBlocks[i]) {
      editorBlocks[i].text = ta.value;
      autoGrow(ta);
      syncBodyFromBlocks();
    }
  });
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.fm-block-btn');
    if (!btn) return;
    const i = Number(btn.closest('.fm-block')?.dataset.index);
    if (!Number.isFinite(i)) return;
    if (btn.dataset.act === 'up') moveBlock(i, -1);
    else if (btn.dataset.act === 'down') moveBlock(i, 1);
    else if (btn.dataset.act === 'remove') removeBlock(i);
  });
  panel.addEventListener('dragstart', (e) => {
    const cell = e.target.closest('.media-cell[draggable]');
    if (!cell || !cell.dataset.ph) return;
    e.dataTransfer.setData('text/plain', cell.dataset.ph);
    e.dataTransfer.effectAllowed = 'copy';
  });
}

let draftTimer = null;

export function getCurrentSlug() {
  return state.params.slug || document.getElementById('fm-slug')?.value || '';
}

function draftKey(slug) {
  return 'mosaic_draft_' + (slug || '__new');
}

export default async function renderEditor(signal) {
  const draftId = state.params.draft || '';
  let cloudDraft = null;
  if (draftId) {
    try {
      cloudDraft = await draftsApi.get(draftId);
    } catch {
      cloudDraft = null;
    }
  }
  const slug = cloudDraft?.slug || state.params.slug || '';
  let post = { slug: '', frontMatter: {}, body: '' };
  if (cloudDraft) {
    post = {
      slug: cloudDraft.slug || '',
      frontMatter: cloudDraft.frontMatter || {},
      body: cloudDraft.body || '',
      sha: cloudDraft.baseSha,
    };
  } else if (slug) {
    try {
      post = await postsApi.get(slug);
    } catch {}
  }
  if (signal.aborted) return '';

  // Optimistic-concurrency token for an existing post. `null` tells the Worker
  // this is a create, so an existing slug is a conflict instead of an
  // accidental overwrite.
  state.editor.baseSha = slug ? post.sha || null : null;

  const fm = post.frontMatter || {};
  state.editor.mediaRefs = normalizeMediaRefs(fm.media);
  state.editor.assetCache = {};
  state.editor.draftMode = Boolean(cloudDraft);
  state.editor.cloudDraftId = draftId || cloudDraftKeyFor(slug);
  state.editor.cloudDraftRevision = cloudDraft?.revision || null;
  state.editor.cloudDraft = cloudDraft;
  const draft = cloudDraft ? null : loadDraft(slug);
  const prefillCat = !slug ? state.params.cat || '' : '';
  const prefillTags = !slug ? state.params.tags || '' : '';
  const fmv = (key, fallback = '') =>
    draft && draft[key] !== undefined && draft[key] !== null ? draft[key] : (fm[key] ?? fallback);
  const body = draft ? (draft.body !== undefined ? draft.body : post.body || '') : post.body || '';
  const catValue = fmv('category') || prefillCat;
  const tagsValue = fmv('tags') || prefillTags;

  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>${cloudDraft ? t('editor.draftTitle') : slug ? t('editor.editTitle') : t('editor.newPost')}</h1>
            <p class="page-subtitle">${cloudDraft ? t('editor.cloudDraftHint') : t('editor.draftHint')}</p>
          </div>
          <div class="page-header-actions">
            ${
              cloudDraft
                ? `<button class="btn btn-ghost" onclick="window.openPreview()"><i class="ri-eye-line"></i> ${t('editor.previewAction')}</button>
                   <button class="btn btn-secondary" onclick="window.saveDraftNow()"><i class="ri-save-line"></i> ${t('editor.saveDraft')}</button>
                   <button class="btn btn-primary" id="editor-save-btn" onclick="window.publishDraft()"><i class="ri-send-plane-line"></i> ${t('editor.publish')}</button>`
                : `<button class="btn btn-secondary" onclick="doSavePost(true)"><i class="ri-arrow-left-line"></i> ${t('editor.saveAndBack')}</button>
                   <button class="btn btn-primary" id="editor-save-btn" onclick="doSavePost()"><i class="ri-save-line"></i> ${t('editor.save')}</button>`
            }
          </div>
        </div>

        ${
          draft
            ? `
          <div class="draft-banner" id="draft-banner">
            <i class="ri-time-line"></i>
            <span>${t('editor.draftRestore', { time: new Date(draft.updatedAt).toLocaleString() })}</span>
            <span class="draft-actions">
              <button class="btn btn-secondary btn-sm" onclick="window.restoreDraft()"><i class="ri-arrow-up-line"></i> ${t('editor.restore')}</button>
              <button class="btn btn-ghost btn-sm" onclick="window.discardDraft()"><i class="ri-close-line"></i> ${t('editor.discard')}</button>
            </span>
          </div>`
            : ''
        }

        <div class="draft-banner cloud-draft-banner" id="cloud-draft-banner" hidden>
          <i class="ri-cloud-line" aria-hidden="true"></i>
          <span id="cloud-draft-text"></span>
          <span class="draft-actions">
            <button class="btn btn-secondary btn-sm" onclick="window.restoreCloudDraft()"><i class="ri-download-cloud-line"></i> ${t('editor.cloudRestore')}</button>
            <button class="btn btn-ghost btn-sm" onclick="window.discardCloudDraft()"><i class="ri-close-line"></i> ${t('editor.discard')}</button>
          </span>
        </div>

        <div class="editor-layout">
          <div class="editor-fields">
            <div class="editor-section-title">${t('editor.infoTitle')}</div>
            <label class="field">
              <span class="field-label">${t('editor.date')}</span>
              <input type="date" id="fm-date" class="input" value="${escHtml(fmv('date') || new Date().toISOString().split('T')[0])}" />
            </label>
            <label class="field">
              <span class="field-label">${t('editor.category')}</span>
              <input type="text" id="fm-category" class="input" value="${escHtml(catValue)}" placeholder="photography/nature" />
              <span class="field-hint">${t('editor.catHint')}</span>
            </label>
            <label class="field">
              <span class="field-label">${t('editor.tags')}</span>
              <input type="text" id="fm-tags" class="input" value="${escHtml(Array.isArray(tagsValue) ? tagsValue.join(', ') : tagsValue)}" placeholder="tag1, tag2" />
            </label>
            <label class="field">
              <span class="field-label">${t('editor.description')}</span>
              <textarea id="fm-desc" class="textarea" rows="2">${escHtml(fmv('description'))}</textarea>
            </label>
            <div class="editor-section-title">${t('editor.cover')}</div>
            <label class="field">
              <input type="text" id="fm-cover" class="input" value="${escHtml(fmv('cover'))}" placeholder="${t('editor.coverPlaceholder')}" />
              <span class="field-hint">${t('editor.coverHint')}</span>
            </label>
            <div class="cover-preview" id="cover-preview"></div>
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.openCoverPicker()"><i class="ri-image-line"></i> ${t('editor.coverPicker')}</button>

            <div class="editor-section-title">${t('editor.views')} / ${t('editor.likes')}</div>
            <div class="input-group">
              <label class="field" style="flex:1">
                <span class="field-label"><i class="ri-eye-line"></i> ${t('editor.views')}</span>
                <input type="number" id="fm-views" class="input" value="${fmv('views', 0)}" />
              </label>
              <label class="field" style="flex:1">
                <span class="field-label"><i class="ri-heart-line"></i> ${t('editor.likes')}</span>
                <input type="number" id="fm-likes" class="input" value="${fmv('likes', 0)}" />
              </label>
            </div>
            <span class="field-hint">${t('editor.statsNote')}</span>
          </div>

          <div class="editor-body">
            <div class="editor-titlebar">
              <input
                type="text"
                id="fm-title"
                class="editor-title-input"
                value="${escHtml(fmv('title'))}"
                placeholder="${t('editor.titlePlaceholder')}"
                aria-label="${t('editor.title')}"
              />
              <div class="editor-slug-row">
                <span class="editor-slug-prefix">/posts/</span>
                <input
                  type="text"
                  id="fm-slug"
                  class="editor-slug-input"
                  value="${escHtml(slug)}"
                  ${slug ? 'readonly' : ''}
                  placeholder="my-post"
                  aria-label="${t('editor.slug')}"
                />
                ${!slug ? `<span class="editor-slug-hint">${t('editor.slugHint')}</span>` : ''}
              </div>
            </div>
            <div class="toolbar" role="toolbar" aria-label="Markdown">
              <button class="toolbar-btn" title="${t('editor.bold')}" aria-label="${t('editor.bold')}" onclick="editorToolbar('bold')"><i class="ri-bold"></i></button>
              <button class="toolbar-btn" title="${t('editor.italic')}" aria-label="${t('editor.italic')}" onclick="editorToolbar('italic')"><i class="ri-italic"></i></button>
              <button class="toolbar-btn" title="${t('editor.link')}" aria-label="${t('editor.link')}" onclick="editorToolbar('link')"><i class="ri-link"></i></button>
              <button class="toolbar-btn" title="${t('editor.image')}" aria-label="${t('editor.image')}" onclick="editorToolbar('image')"><i class="ri-image-line"></i></button>
              <button class="toolbar-btn" title="${t('editor.quote')}" aria-label="${t('editor.quote')}" onclick="editorToolbar('quote')"><i class="ri-double-quotes-l"></i></button>
              <button class="toolbar-btn" title="${t('editor.list')}" aria-label="${t('editor.list')}" onclick="editorToolbar('list')"><i class="ri-list-unordered"></i></button>
              <button class="toolbar-btn" title="${t('editor.code')}" aria-label="${t('editor.code')}" onclick="editorToolbar('code')"><i class="ri-code-box-line"></i></button>
              <span class="toolbar-sep"></span>
              <div class="tabs" role="tablist">
                <button class="tab-btn active" data-mode="edit" role="tab" onclick="editorMode('edit')">${t('editor.edit')}</button>
                <button class="tab-btn" data-mode="preview" role="tab" onclick="editorMode('preview')">${t('editor.previewAction')}</button>
                <button class="tab-btn" data-mode="split" role="tab" onclick="editorMode('split')">${t('editor.split')}</button>
              </div>
            </div>
            <textarea id="fm-body" spellcheck="false" aria-label="${t('editor.body')}" style="display:none">${escHtml(body)}</textarea>
            <div id="fm-blocks" class="fm-blocks" aria-label="${t('editor.body')}"></div>
            <p class="placeholder-hint" id="placeholder-hint"><i class="ri-drag-drop-line"></i> ${t('editor.placeholderHint')}</p>
            <div class="markdown-preview hidden" id="fm-preview"></div>
          </div>

          <div class="editor-media-panel">
            <h2 class="media-panel-collapse" onclick="toggleMediaPanel()"><i class="ri-upload-cloud-2-line"></i> ${t('editor.mediaPanel')} <i class="ri-arrow-down-s-line" id="media-panel-caret" style="margin-left:auto"></i></h2>
            <div id="media-panel-body" class="media-panel-body">
              <div class="editor-section-title">${t('editor.assetLibrary')}</div>
              <button type="button" class="btn btn-secondary btn-sm" data-open-asset-picker>
                <i class="ri-hard-drive-3-line" aria-hidden="true"></i> ${t('editor.pickAssets')}
              </button>
              <div id="v2-media-list" class="v2-media-list"></div>
              <label class="upload-keep-source" for="upload-keep-source">
                <input type="checkbox" id="upload-keep-source" ${state.config.media?.keepSourceFiles !== false ? 'checked' : ''} />
                <span class="upload-keep-copy">
                  <span class="upload-keep-title">${t('editor.keepSourceUpload')}</span>
                  <small>${t('editor.keepSourceUploadHint')}</small>
                </span>
              </label>
              <div class="upload-zone" id="upload-zone" role="button" tabindex="0" aria-label="${t('editor.upload')}">
                <i class="ri-upload-cloud-2-line"></i>
                <p>${t('editor.uploadHint')}</p>
                <p class="upload-zone-hint">${t('editor.uploadHintSub')}</p>
                <input type="file" id="editor-media-input" multiple accept="image/*,video/*,audio/*" style="display:none" />
              </div>
              <div id="upload-progress" style="margin-top:10px"></div>
              <div id="existing-media" style="margin-top:14px"></div>
            </div>
          </div>
        </div>
      </div>
    `,
    onMount() {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(previewTimer);
          clearTimeout(draftTimer);
          clearTimeout(cloudDraftTimer);
          clearTimeout(previewPollTimer);
          state.editor.draftSnapshot = null;
        },
        { once: true },
      );
      state.editorDirty = false;
      state.editor.media = { photos: [], videos: [], music: [] };
      state.editorDraftKey = slug || null;
      setMediaPanelHooks({
        onMediaUpdated: (firstRender) => {
          if (firstRender) renderBlocksFromBody();
          else refreshBlockMedia();
        },
      });
      wireEditorInputs();
      wireBodyDnD();
      renderBlocksFromBody();
      updateCoverPreview();
      renderSelectedMedia();
      loadSelectedAssets();
      document.querySelector('[data-open-asset-picker]')?.addEventListener('click', openAssetPicker);
      if (!state.editor.draftMode) loadCloudDraft(signal);
      if (slug) loadExistingMedia(slug);
      state.editor.draftSnapshot = null;
      if (draft) {
        state.editor.draftSnapshot = draft;
      }
    },
  };
}

export const editorSkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:100px;height:30px"></div></div>
    <div class="editor-layout">
      <div class="skeleton-card">${[1, 2, 3, 4, 5, 6, 7, 8].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
      <div class="skeleton-card"><div class="skeleton skeleton-box" style="height:360px"></div></div>
    </div>
  </div>
`;

// ── Cloud drafts (R2) ──────────────────────
function cloudDraftKeyFor(slug) {
  try {
    return localStorage.getItem('mosaic_cloud_draft_' + (slug || '__new')) || null;
  } catch {
    return null;
  }
}

function rememberCloudDraft(slug, id) {
  try {
    localStorage.setItem('mosaic_cloud_draft_' + (slug || '__new'), id);
  } catch {}
}

function forgetCloudDraft(slug) {
  try {
    localStorage.removeItem('mosaic_cloud_draft_' + (slug || '__new'));
  } catch {}
}

function cloudDraftPayload() {
  const fields = (id) => document.getElementById(id)?.value || '';
  return {
    slug: getCurrentSlug(),
    title: fields('fm-title'),
    body: fields('fm-body'),
    baseSha: state.editor.baseSha ?? null,
    frontMatter: {
      title: fields('fm-title'),
      date: fields('fm-date'),
      category: fields('fm-category'),
      tags: fields('fm-tags')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      description: fields('fm-desc'),
      cover: fields('fm-cover'),
      views: parseInt(fields('fm-views')) || 0,
      likes: parseInt(fields('fm-likes')) || 0,
    },
    media: state.editor.mediaRefs || normalizeMediaRefs(null),
    revision: state.editor.cloudDraftRevision || undefined,
  };
}

async function refreshCloudDraftRevision(id) {
  try {
    const latest = await draftsApi.get(id);
    state.editor.cloudDraftRevision = latest.revision;
    return latest;
  } catch {
    return null;
  }
}

async function saveCloudDraft() {
  if (cloudDraftBusy || !state.editorDirty) return;
  cloudDraftBusy = true;
  const slug = state.params.slug || '';
  let id = cloudDraftKeyFor(slug);
  try {
    if (!id) {
      const created = await draftsApi.create(cloudDraftPayload());
      if (!created?.id) return;
      id = created.id;
      state.editor.cloudDraftId = id;
      state.editor.cloudDraftRevision = created.revision;
      rememberCloudDraft(slug, id);
    } else {
      const saved = await draftsApi.save(id, cloudDraftPayload());
      state.editor.cloudDraftRevision = saved.revision;
    }
  } catch (error) {
    if (error.status === 409 && id) {
      await refreshCloudDraftRevision(id);
      toast(t('editor.cloudDraftConflict'), 'warning', 6000);
    }
  } finally {
    cloudDraftBusy = false;
  }
}

function scheduleCloudDraft() {
  clearTimeout(cloudDraftTimer);
  cloudDraftTimer = setTimeout(saveCloudDraft, 2000);
}

async function loadCloudDraft(signal) {
  const id = state.editor.cloudDraftId;
  if (!id) return;
  try {
    const draft = await draftsApi.get(id);
    if (signal.aborted) return;
    state.editor.cloudDraft = draft;
    state.editor.cloudDraftRevision = draft.revision;
    const same =
      draft.body === (document.getElementById('fm-body')?.value || '') &&
      (draft.title || '') === (document.getElementById('fm-title')?.value || '');
    if (same) return;
    const banner = document.getElementById('cloud-draft-banner');
    const text = document.getElementById('cloud-draft-text');
    if (banner && text) {
      text.textContent = t('editor.cloudDraftFound', { time: new Date(draft.updatedAt).toLocaleString() });
      banner.hidden = false;
    }
  } catch {
    /* cloud drafts are a backup; a missing one must not block editing */
  }
}

window.restoreCloudDraft = () => {
  const draft = state.editor.cloudDraft;
  if (!draft) return;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el && value !== undefined && value !== null) el.value = value;
  };
  const fm = draft.frontMatter || {};
  set('fm-slug', draft.slug || '');
  set('fm-title', draft.title || fm.title || '');
  set('fm-date', fm.date || '');
  set('fm-category', fm.category || '');
  set('fm-tags', Array.isArray(fm.tags) ? fm.tags.join(', ') : fm.tags || '');
  set('fm-desc', fm.description || '');
  set('fm-cover', fm.cover || '');
  set('fm-views', fm.views || 0);
  set('fm-likes', fm.likes || 0);
  set('fm-body', draft.body || '');
  state.editor.mediaRefs = normalizeMediaRefs(draft.media);
  renderSelectedMedia();
  loadSelectedAssets();
  renderBlocksFromBody();
  updateCoverPreview();
  state.editorDirty = true;
  document.getElementById('cloud-draft-banner').hidden = true;
  toast(t('editor.cloudRestored'), 'success');
};

window.discardCloudDraft = async () => {
  const id = state.editor.cloudDraftId;
  if (id) await draftsApi.delete(id).catch(() => {});
  forgetCloudDraft(state.params.slug || '');
  state.editor.cloudDraft = null;
  const banner = document.getElementById('cloud-draft-banner');
  if (banner) banner.hidden = true;
  toast(t('editor.cloudDraftDiscarded'), 'info', 3000);
};

async function cleanupCloudDraft() {
  const id = state.editor.cloudDraftId || cloudDraftKeyFor(state.params.slug || '');
  if (id) await draftsApi.delete(id).catch(() => {});
  forgetCloudDraft(state.params.slug || '');
  state.editor.cloudDraft = null;
  const banner = document.getElementById('cloud-draft-banner');
  if (banner) banner.hidden = true;
}

async function persistDraft({ silent = false } = {}) {
  if (cloudDraftBusy) return null;
  cloudDraftBusy = true;
  const slug = state.params.slug || '';
  try {
    const payload = cloudDraftPayload();
    let id = state.editor.cloudDraftId;
    let saved;
    if (!id) {
      saved = await draftsApi.create(payload);
      id = saved.id;
      state.editor.cloudDraftId = id;
      rememberCloudDraft(slug, id);
    } else {
      saved = await draftsApi.save(id, payload);
    }
    state.editor.cloudDraftRevision = saved.revision;
    state.editor.cloudDraft = saved;
    state.editorDirty = false;
    if (!silent) toast(t('editor.draftSaved'), 'success');
    return saved;
  } catch (error) {
    if (error.status === 409) {
      if (state.editor.cloudDraftId) await refreshCloudDraftRevision(state.editor.cloudDraftId);
      toast(t('editor.cloudDraftConflict'), 'warning', 7000);
    } else toast(t('editor.saveFailed') + ': ' + (error.message || ''), 'error');
    return null;
  } finally {
    cloudDraftBusy = false;
  }
}

window.saveDraftNow = () => persistDraft();

window.publishDraft = async () => {
  const saved = await persistDraft({ silent: true });
  if (!saved) return;
  const id = state.editor.cloudDraftId;
  try {
    await draftsApi.publish(id);
    forgetCloudDraft(state.params.slug || '');
    state.editor.cloudDraftId = null;
    state.editor.cloudDraft = null;
    state.editorDirty = false;
    try {
      localStorage.removeItem(draftKey(state.params.slug || '__new'));
    } catch {}
    toast(t('editor.published'), 'success', 5000);
    location.hash = 'posts';
  } catch (error) {
    if (error.status === 409) toast(t('editor.conflict'), 'error', 9000);
    else toast(t('editor.publishFailed') + ': ' + (error.message || ''), 'error');
  }
};

window.openPreview = async () => {
  const saved = await persistDraft({ silent: true });
  if (!saved) return;
  const id = state.editor.cloudDraftId;
  let created;
  try {
    created = await previewsApi.create(id);
  } catch (error) {
    toast(t('editor.previewFailed') + ': ' + (error.message || ''), 'error');
    return;
  }
  toast(t('editor.previewBuilding'), 'info', 5000);
  const url = `/api/preview/${created.token}/`;
  const started = Date.now();
  const poll = async () => {
    if (state.page !== 'editor') return;
    try {
      const status = await previewsApi.status(created.previewId);
      if (status.status === 'ready') {
        toast(t('editor.previewReady'), 'success', 20000, {
          label: t('editor.openPreview'),
          onClick: () => window.open(url, '_blank', 'noopener'),
        });
        return;
      }
      if (status.status === 'failed') {
        toast(t('editor.previewFailed') + ': ' + (status.error || ''), 'error', 10000);
        return;
      }
      if (Date.now() - started > 5 * 60 * 1000) {
        toast(t('editor.previewTimeout'), 'error');
        return;
      }
      previewPollTimer = setTimeout(poll, 2500);
    } catch {
      previewPollTimer = setTimeout(poll, 4000);
    }
  };
  poll();
};

// ── Drafts ─────────────────────────────────
function loadDraft(slug) {
  try {
    const raw = localStorage.getItem(draftKey(slug));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveDraft() {
  // Key drafts by a stable bucket: the URL slug for edits, '__new' for new
  // posts. The typed slug lives in data.slug (restoreDraft fills the field),
  // so a refresh before creation still finds the draft.
  const key = state.params.slug || '__new';
  state.editorDraftKey = key;
  const data = {
    slug: getCurrentSlug(),
    title: document.getElementById('fm-title')?.value || '',
    date: document.getElementById('fm-date')?.value || '',
    category: document.getElementById('fm-category')?.value || '',
    tags: (document.getElementById('fm-tags')?.value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    description: document.getElementById('fm-desc')?.value || '',
    cover: document.getElementById('fm-cover')?.value || '',
    views: parseInt(document.getElementById('fm-views')?.value) || 0,
    likes: parseInt(document.getElementById('fm-likes')?.value) || 0,
    body: document.getElementById('fm-body')?.value || '',
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(draftKey(key), JSON.stringify(data));
  } catch {}
  scheduleCloudDraft();
}

function wireEditorInputs() {
  const fields = document.querySelectorAll(
    '#fm-title, #fm-date, #fm-category, #fm-tags, #fm-desc, #fm-cover, #fm-views, #fm-likes, #fm-slug, #fm-body',
  );
  const onInput = () => {
    state.editorDirty = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 1500);
  };
  fields.forEach((el) => el.addEventListener('input', onInput));
}

window.restoreDraft = () => {
  const d = state.editor.draftSnapshot;
  if (!d) return;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el && el.value !== v) el.value = v;
  };
  set('fm-slug', d.slug || '');
  set('fm-title', d.title || '');
  set('fm-date', d.date || '');
  set('fm-category', d.category || '');
  set('fm-tags', (d.tags || []).join(', '));
  set('fm-desc', d.description || '');
  set('fm-cover', d.cover || '');
  set('fm-views', d.views || 0);
  set('fm-likes', d.likes || 0);
  set('fm-body', d.body || '');
  renderBlocksFromBody();
  state.editorDirty = true;
  updateCoverPreview();
  document.getElementById('draft-banner')?.remove();
  toast(t('editor.draftRestored'), 'success');
  state.editor.draftSnapshot = null;
};

window.discardDraft = () => {
  const key = draftKey(state.params.slug || '__new');
  let backup = null;
  try {
    backup = localStorage.getItem(key);
    localStorage.removeItem(key);
  } catch {}
  document.getElementById('draft-banner')?.remove();
  state.editor.draftSnapshot = null;
  toast(
    t('editor.draftDiscarded'),
    'info',
    6000,
    backup
      ? {
          // Cheap, lossless undo: the draft snapshot is still in memory.
          label: t('common.undo'),
          onClick: () => {
            try {
              localStorage.setItem(key, backup);
            } catch {}
            toast(t('editor.draftUndone'), 'success', 3000);
          },
        }
      : undefined,
  );
};

// ── Media v2 asset picker ──────────────────
function normalizeMediaRefs(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const list = (input) => (Array.isArray(input) ? input.filter((id) => typeof id === 'string' && id) : []);
  return {
    gallery: list(source.gallery),
    videos: list(source.videos),
    music: list(source.music),
    cover: typeof source.cover === 'string' && source.cover ? source.cover : null,
  };
}

function assetPreview(asset) {
  return `/api/assets/${encodeURIComponent(asset.id)}/preview`;
}

function refsIds(refs = state.editor.mediaRefs) {
  return [
    ...new Set([
      ...(refs.gallery || []),
      ...(refs.videos || []),
      ...(refs.music || []),
      ...(refs.cover ? [refs.cover] : []),
    ]),
  ];
}

function renderSelectedMedia() {
  const el = document.getElementById('v2-media-list');
  if (!el) return;
  const refs = state.editor.mediaRefs || normalizeMediaRefs(null);
  const ids = refsIds(refs);
  if (!ids.length) {
    el.innerHTML = `<p class="field-hint">${t('editor.pickAssetsHint')}</p>`;
    return;
  }
  el.innerHTML = ids
    .map((id) => {
      const asset = state.editor.assetCache?.[id];
      return `<span class="v2-media-chip" title="${escHtml(asset?.filename || id)}">
        ${asset ? `<img src="${escHtml(assetPreview(asset))}" alt="" loading="lazy" onerror="this.style.display='none'" />` : '<i class="ri-file-line" aria-hidden="true"></i>'}
        <span>${escHtml(asset?.filename || id)}</span>
      </span>`;
    })
    .join('');
}

async function loadSelectedAssets() {
  const ids = refsIds();
  if (!ids.length) return;
  try {
    const result = await assetsApi.list({ ids: ids.join(',') });
    if (state.page !== 'editor') return;
    for (const asset of result.assets || []) state.editor.assetCache[asset.id] = asset;
    renderSelectedMedia();
    updateCoverPreview();
    refreshBlockMedia();
  } catch {
    /* previews degrade to file labels */
  }
}

function attachAssets(ids) {
  const refs = state.editor.mediaRefs || normalizeMediaRefs(null);
  let changed = false;
  let musicPlaceholderAdded = false;
  for (const id of ids) {
    const asset = state.editor.assetCache?.[id];
    if (!asset) continue;
    if (asset.folder === 'videos') {
      if (refs.videos.includes(id)) continue;
      refs.videos.push(id);
      window.insertPlaceholder?.(`{{video:${refs.videos.length - 1}}}`);
      changed = true;
    } else if (asset.folder === 'music') {
      if (refs.music.includes(id)) continue;
      refs.music.push(id);
      if (!musicPlaceholderAdded) {
        window.insertPlaceholder?.('{{music}}');
        musicPlaceholderAdded = true;
      }
      changed = true;
    } else {
      if (refs.gallery.includes(id)) continue;
      refs.gallery.push(id);
      window.insertPlaceholder?.(`{{photo:${refs.gallery.length - 1}}}`);
      changed = true;
    }
  }
  if (changed) {
    state.editor.mediaRefs = refs;
    state.editorDirty = true;
    renderSelectedMedia();
  }
}

async function openAssetPicker() {
  let result;
  try {
    result = await assetsApi.list({});
  } catch (error) {
    toast(t('editor.loadError') + ': ' + (error.message || ''), 'error');
    return;
  }
  const list = (result.assets || []).filter((asset) => asset.status !== 'deleted');
  if (!list.length) {
    toast(t('editor.assetLibraryEmpty'), 'info');
    return;
  }
  for (const asset of list) state.editor.assetCache[asset.id] = asset;
  const selected = new Set();
  const content = list.length
    ? `<div class="asset-pick-grid">${list
        .map(
          (
            asset,
          ) => `<button type="button" class="asset-pick" data-asset-id="${escHtml(asset.id)}" aria-pressed="false">
            <span class="asset-pick-thumb"><img src="${escHtml(assetPreview(asset))}" alt="" loading="lazy" onerror="this.style.display='none'" /><i class="ri-file-line" aria-hidden="true"></i></span>
            <span class="asset-pick-name">${escHtml(asset.filename)}</span>
            <span class="asset-pick-meta">${escHtml(asset.folder)} · ${escHtml(t('jobs.' + asset.status) || asset.status)}</span>
          </button>`,
        )
        .join('')}</div>`
    : '';
  const overlay = openModal({
    title: t('editor.pickAssetsTitle'),
    desc: t('editor.pickAssetsDesc'),
    content,
    wide: true,
    actions: [
      { label: t('common.cancel'), className: 'btn-secondary' },
      {
        label: t('editor.insertSelected'),
        className: 'btn-primary',
        closeOnClick: false,
        onClick: () => {
          attachAssets([...selected]);
          closeModal();
        },
      },
    ],
  });
  overlay?.addEventListener('click', (event) => {
    const button = event.target.closest('.asset-pick');
    if (!button) return;
    const id = button.dataset.assetId;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    button.classList.toggle('is-selected', selected.has(id));
    button.setAttribute('aria-pressed', selected.has(id) ? 'true' : 'false');
  });
}

// ── Save ───────────────────────────────────
window.doSavePost = async (goBack) => {
  if (state.editor.draftMode) {
    await window.saveDraftNow?.();
    return;
  }
  let slug = document.getElementById('fm-slug').value.trim();
  const title = document.getElementById('fm-title').value.trim();
  if (!slug) {
    toast(t('editor.noSlug'), 'error');
    document.getElementById('fm-slug')?.focus();
    return;
  }
  const frontMatter = {
    title,
    date: document.getElementById('fm-date').value,
    category: document.getElementById('fm-category').value.trim(),
    tags: document
      .getElementById('fm-tags')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    description: document.getElementById('fm-desc').value,
    cover: state.editor.mediaRefs?.cover || document.getElementById('fm-cover').value.trim(),
    views: parseInt(document.getElementById('fm-views')?.value) || 0,
    likes: parseInt(document.getElementById('fm-likes')?.value) || 0,
  };
  const media = state.editor.mediaRefs;
  if (media && refsIds(media).length) frontMatter.media = media;
  const body = document.getElementById('fm-body').value;
  const btn = document.getElementById('editor-save-btn');
  btn.disabled = true;
  try {
    let result;
    if (state.params.slug) {
      result = await postsApi.update(state.params.slug, {
        frontMatter,
        body,
        baseSha: state.editor.baseSha,
      });
    } else {
      result = await postsApi.create({ slug, frontMatter, body, baseSha: null });
      location.hash = 'editor&slug=' + encodeURIComponent(slug);
    }
    if (result?.sha) state.editor.baseSha = result.sha;
    try {
      localStorage.removeItem(draftKey(state.params.slug || '__new'));
      if (!state.params.slug) localStorage.removeItem(draftKey(slug));
    } catch {}
    state.editorDirty = false;
    await cleanupCloudDraft();
    window.checkDirty && window.checkDirty();
    toast(t('editor.saved'), 'success');
    if (goBack) location.hash = 'posts';
  } catch (err) {
    if (err.status === 409 || err.code === 'CONFLICT' || err.code === 'SLUG_CONFLICT') {
      toast(t('editor.conflict'), 'error', 9000);
    } else {
      toast(t('editor.saveFailed') + ': ' + err.message, 'error');
    }
  } finally {
    btn.disabled = false;
  }
};

// ── Markdown toolbar / modes ───────────────
function wrapSelection(before, after, placeholder) {
  const ta =
    document.activeElement && document.activeElement.classList.contains('fm-text-block')
      ? document.activeElement
      : document.querySelector('#fm-blocks .fm-text-block');
  if (!ta) return;
  const start = ta.selectionStart,
    end = ta.selectionEnd;
  const selected = ta.value.slice(start, end) || placeholder;
  ta.setRangeText(before + selected + after, start, end, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

window.editorToolbar = (kind) => {
  const map = {
    bold: ['**', '**', 'bold'],
    italic: ['*', '*', 'italic'],
    code: ['`', '`', 'code'],
    quote: ['\n> ', '', 'quote'],
    list: ['\n- ', '', 'item'],
    link: ['[', '](https://)', 'link text'],
    image: ['![', '](photos/)', 'alt text'],
  };
  const [b, a, ph] = map[kind];
  wrapSelection(b, a, ph);
};

window.editorMode = async (mode) => {
  const blocksEl = document.getElementById('fm-blocks');
  const preview = document.getElementById('fm-preview');
  if (!blocksEl || !preview) return;
  previewVisible = mode === 'preview' || mode === 'split';
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  blocksEl.classList.toggle('hidden', mode === 'preview');
  preview.classList.toggle('hidden', mode !== 'preview' && mode !== 'split');
  preview.style.display = mode === 'preview' || mode === 'split' ? 'block' : 'none';
  if (mode === 'split') {
    blocksEl.style.width = '50%';
    blocksEl.style.float = 'left';
    blocksEl.style.borderRight = '1px solid var(--color-border-light)';
    preview.style.width = '50%';
    preview.style.float = 'right';
    preview.style.minHeight = blocksEl.offsetHeight + 'px';
  } else {
    blocksEl.style.width = '100%';
    blocksEl.style.float = 'none';
    blocksEl.style.borderRight = 'none';
    preview.style.width = '100%';
    preview.style.float = 'none';
  }
  if (mode !== 'edit') await renderPreview();
};

async function renderPreview() {
  const preview = document.getElementById('fm-preview');
  if (!preview) return;
  try {
    await Promise.all([loadLib(MARKED_URL), loadLib(PURIFY_URL)]);
  } catch {
    preview.innerHTML = '<p class="muted">Preview unavailable</p>';
    return;
  }
  const raw = document.getElementById('fm-body').value || '';
  const slug = getCurrentSlug();
  // Isolate standalone placeholder lines so Markdown renders the rest, then
  // swap tokens for live preview cards (same rules as scripts/blocks.mjs).
  const media = state.editor.media || { photos: [], videos: [], music: [] };
  const lines = raw.split('\n');
  const cards = [];
  const protectedLines = lines.map((line, i) => {
    const m = PLACEHOLDER_RE.exec(line);
    const prevBlank = i === 0 || !lines[i - 1].trim();
    const nextBlank = i === lines.length - 1 || !lines[i + 1].trim();
    if (m && prevBlank && nextBlank) {
      const token = `@@MPH${cards.length}@@`;
      cards.push(buildPlaceholderCard(m[1], media));
      return token;
    }
    return line;
  });
  let html = window.marked.parse(protectedLines.join('\n'), { async: false, breaks: true });
  html = window.DOMPurify.sanitize(html);
  // Resolve relative media paths against the originals bucket for preview
  if (slug) {
    const base = (state.mediaBase || '').replace(/\/$/, '');
    html = html.replace(
      /(src|href)="((?:photos|videos|covers)\/[^"]+)"/g,
      (m, attr, path) => `${attr}="${base}/originals/${encodeURIComponent(slug)}/${path}"`,
    );
  }
  cards.forEach((card, i) => {
    html = html.replace(`@@MPH${i}@@`, card);
  });
  preview.innerHTML = html;
}

function placeholderCard(raw, iconClass, title, meta, thumbsHtml = '') {
  return `
    <div class="ph-card" data-ph="${escHtml(raw)}">
      <div class="ph-card-icon"><i class="${iconClass}"></i></div>
      <div class="ph-card-body">
        <span class="ph-card-title">{{${escHtml(raw)}}}</span>
        <span class="ph-card-meta">${title}${meta ? ' · ' + meta : ''}</span>
        ${thumbsHtml}
      </div>
    </div>`;
}

function placeholderErrorCard(raw, total) {
  return `
    <div class="ph-card ph-card-error" data-ph="${escHtml(raw)}">
      <div class="ph-card-icon"><i class="ri-error-warning-line"></i></div>
      <div class="ph-card-body">
        <span class="ph-card-title">{{${escHtml(raw)}}}</span>
        <span class="ph-card-meta">${t('editor.placeholderOutOfRange', { n: total })}</span>
      </div>
    </div>`;
}

function buildPlaceholderCard(raw, media) {
  const kind = raw.split(':')[0];
  if (kind === 'gallery') {
    const items = media.photos || [];
    const thumbs = items
      .slice(0, 5)
      .map((f) => `<img src="${escHtml(f.previewUrl || f.url || '')}" alt="" />`)
      .join('');
    const more = items.length > 5 ? `<span class="ph-card-more">+${items.length - 5}</span>` : '';
    return placeholderCard(
      raw,
      'ri-image-line',
      `${t('editor.placeholderGallery')} · ${items.length} ${t('editor.photos')}`,
      '',
      items.length ? `<div class="ph-card-thumbs">${thumbs}${more}</div>` : '',
    );
  }
  if (kind === 'photo') {
    const item = (media.photos || [])[Number(raw.split(':')[1])];
    if (!item) return placeholderErrorCard(raw, (media.photos || []).length);
    return placeholderCard(
      raw,
      'ri-image-line',
      t('editor.placeholderGallery'),
      escHtml(item.name),
      `<div class="ph-card-thumbs"><img src="${escHtml(item.previewUrl || item.url || '')}" alt="" /></div>`,
    );
  }
  if (kind === 'videos') {
    const n = (media.videos || []).length;
    return placeholderCard(raw, 'ri-video-line', `${t('editor.placeholderVideos')} · ${n}`, '');
  }
  if (kind === 'video') {
    const item = (media.videos || [])[Number(raw.split(':')[1])];
    if (!item) return placeholderErrorCard(raw, (media.videos || []).length);
    return placeholderCard(raw, 'ri-video-line', t('editor.placeholderVideos'), escHtml(item.name));
  }
  const n = (media.music || []).length;
  return placeholderCard(raw, 'ri-music-2-line', `${t('editor.placeholderMusic')} · ${n}`, '');
}

// ── Cover ──────────────────────────────────
export function updateCoverPreview() {
  const el = document.getElementById('cover-preview');
  const val = document.getElementById('fm-cover')?.value || '';
  if (!el) return;
  const media = state.editor.media || { photos: [], videos: [] };
  const asset = state.editor.assetCache?.[val];
  if (asset) {
    el.style.display = 'block';
    el.innerHTML = `<img src="${escHtml(assetPreview(asset))}" alt="cover" />`;
    return;
  }
  const match = /^(video|photo):(\d+)$/.exec(val);
  const selected = match
    ? media[match[1] === 'video' ? 'videos' : 'photos'][Number(match[2])]
    : [...(media.covers || []), ...media.photos].find((item) => item.name === val);
  const url = selected?.previewUrl || selected?.url || (/^(https?:\/\/|\/)/.test(val) ? val : '');
  if (url) {
    el.style.display = 'block';
    el.innerHTML = `<img src="${escHtml(url)}" alt="cover" />`;
  } else {
    el.style.display = 'none';
    el.innerHTML = '';
  }
}

window.openCoverPicker = async () => {
  const slug = getCurrentSlug();
  if (!slug) {
    toast(t('editor.needSlugTitle'), 'info');
    return;
  }
  let data;
  try {
    data = await mediaApi.list(slug);
  } catch {
    toast(t('editor.loadError'), 'error');
    return;
  }
  const photos = [...(data.photos || []), ...(data.covers || [])];
  const videos = data.videos || [];
  let content = '';
  if (!photos.length && !videos.length) {
    content = `<div class="media-empty">${t('editor.noMedia')}</div>`;
  } else {
    if (photos.length) {
      content +=
        `<div class="editor-section-title" style="margin:10px 0 6px">${t('editor.cover')} — ${t('editor.views')}</div><div class="media-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">` +
        photos
          .map(
            (f) => `
          <div class="media-cell" onclick="pickCover(${jsStr(f.name)})" title="${escHtml(f.name)}" style="cursor:pointer">
            <img src="${escHtml(f.previewUrl || f.url || '')}" alt="${escHtml(f.name)}" loading="lazy" />
            <div class="media-cell-name">${escHtml(f.name)}</div>
          </div>`,
          )
          .join('') +
        '</div>';
    }
    if (videos.length) {
      content +=
        `<div class="editor-section-title" style="margin:10px 0 6px">${t('editor.cover')} — ${t('editor.upload')}</div><div class="media-grid" style="grid-template-columns:repeat(4,1fr)">` +
        videos
          .map(
            (f, index) => `
          <div class="media-cell" onclick="pickCover('video:${index}')" title="${escHtml(f.name)}">
            <div class="media-cell-icon"><i class="ri-video-line"></i></div>
            <div class="media-cell-name">${escHtml(f.name)}</div>
          </div>`,
          )
          .join('') +
        '</div>';
    }
  }
  openModal({ title: t('editor.coverPicker'), desc: t('editor.coverHint'), content, wide: true, actions: [] });
};

window.pickCover = (name) => {
  const input = document.getElementById('fm-cover');
  if (input) input.value = name;
  state.editorDirty = true;
  updateCoverPreview();
  closeModal();
  toast(t('editor.coverPicked'), 'success', 2000);
};

window.toggleMediaPanel = () => {
  const body = document.getElementById('media-panel-body');
  const caret = document.getElementById('media-panel-caret');
  if (!body) return;
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? '' : 'none';
  if (caret) caret.className = hidden ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line';
};
