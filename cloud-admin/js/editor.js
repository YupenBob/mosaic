/**
 * Editor page — three-pane post editor with Markdown preview, autosave
 * drafts, cover picker, stats section and the media panel.
 */
import { posts as postsApi, media as mediaApi } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=1';
import { escHtml, toast, modalConfirm, loadLib, openModal, closeModal } from './ui.js?v=1';

const MARKED_URL = 'js/vendor/marked.min.js';
const PURIFY_URL = 'js/vendor/purify.min.js';
const PLACEHOLDER_RE = /^\s*\{\{(gallery|videos|music|video:(\d+)|photo:(\d+))\}\}\s*$/;
const BLOCK_DRAG_PREFIX = '__mosaic_block:';
let editorBlocks = [];
let previewVisible = false;
let previewTimer = null;

function getEditorMedia() {
  return window._editorMedia || { photos: [], videos: [], music: [] };
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
      .map((f) => `<img src="${escHtml(f.url || '')}" alt="" loading="lazy" />`)
      .join('');
    const more = items.length > 8 ? `<span class="fm-media-more">+${items.length - 8}</span>` : '';
    return items.length ? `<div class="fm-media-gallery">${thumbs}${more}</div>` : `<p class="muted">0</p>`;
  }
  if (b.type === 'photo') {
    const item = (media.photos || [])[b.index];
    return item ? `<img class="fm-media-single" src="${escHtml(item.url || '')}" alt="" loading="lazy" />` : '';
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
  const slug = state.params.slug || '';
  let post = { slug: '', frontMatter: {}, body: '' };
  if (slug) {
    try {
      post = await postsApi.get(slug);
    } catch {}
  }
  if (signal.aborted) return '';

  const fm = post.frontMatter || {};
  const draft = loadDraft(slug);
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
            <h1>${slug ? escHtml(fmv('title') || slug) : t('editor.newPost')}</h1>
            <p class="page-subtitle">${slug ? escHtml(slug) : t('editor.slugHint')}</p>
          </div>
          <div class="page-header-actions">
            <button class="btn btn-secondary" onclick="doSavePost(true)"><i class="ri-arrow-left-line"></i> ${t('editor.saveAndBack')}</button>
            <button class="btn btn-primary" id="editor-save-btn" onclick="doSavePost()"><i class="ri-save-line"></i> ${t('editor.save')}</button>
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

        <div class="editor-layout">
          <div class="editor-fields">
            <div class="editor-section-title">${t('editor.sectionTitle')}</div>
            <label class="field">
              <span class="field-label">${t('editor.slug')}</span>
              <input type="text" id="fm-slug" class="input" value="${escHtml(slug)}" ${slug ? 'readonly' : ''} placeholder="my-post" />
              ${!slug ? `<span class="field-hint">${t('editor.slugHint')}</span>` : ''}
            </label>
            <label class="field">
              <span class="field-label">${t('editor.title')}</span>
              <input type="text" id="fm-title" class="input" value="${escHtml(fmv('title'))}" placeholder="${t('editor.title')}" />
            </label>
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
              <input type="text" id="fm-cover" class="input" value="${escHtml(fmv('cover'))}" placeholder="cover.jpg or video:0 or photo:0" />
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
                <button class="tab-btn" data-mode="preview" role="tab" onclick="editorMode('preview')">${t('editor.preview')}</button>
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
      state.editorDirty = false;
      state.editorDraftKey = slug || null;
      wireEditorInputs();
      wireBodyDnD();
      renderBlocksFromBody();
      updateCoverPreview();
      if (slug) loadExistingMedia(slug);
      window._draftSnapshot = null;
      if (draft) {
        window._draftSnapshot = draft;
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
  const d = window._draftSnapshot;
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
  window._draftSnapshot = null;
};

window.discardDraft = () => {
  try {
    localStorage.removeItem(draftKey(state.params.slug || '__new'));
  } catch {}
  document.getElementById('draft-banner')?.remove();
  window._draftSnapshot = null;
  toast(t('editor.draftDiscarded'), 'info', 2500);
};

// ── Save ───────────────────────────────────
window.doSavePost = async (goBack) => {
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
    cover: document.getElementById('fm-cover').value.trim(),
    views: parseInt(document.getElementById('fm-views')?.value) || 0,
    likes: parseInt(document.getElementById('fm-likes')?.value) || 0,
  };
  const body = document.getElementById('fm-body').value;
  const btn = document.getElementById('editor-save-btn');
  btn.disabled = true;
  try {
    if (state.params.slug) {
      await postsApi.update(state.params.slug, { frontMatter, body });
    } else {
      await postsApi.create({ slug, frontMatter, body });
      location.hash = 'editor&slug=' + encodeURIComponent(slug);
    }
    try {
      localStorage.removeItem(draftKey(state.params.slug || '__new'));
      if (!state.params.slug) localStorage.removeItem(draftKey(slug));
    } catch {}
    state.editorDirty = false;
    window.checkDirty && window.checkDirty();
    toast(t('editor.saved'), 'success');
    if (goBack) location.hash = 'posts';
  } catch (err) {
    toast(t('editor.saveFailed') + ': ' + err.message, 'error');
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
  const media = window._editorMedia || { photos: [], videos: [], music: [] };
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
      .map((f) => `<img src="${escHtml(f.url || '')}" alt="" />`)
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
      `<div class="ph-card-thumbs"><img src="${escHtml(item.url || '')}" alt="" /></div>`,
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
  if (val && !val.startsWith('video:') && !val.startsWith('photo:')) {
    const slug = getCurrentSlug();
    el.style.display = 'block';
    el.innerHTML = `<img src="${escHtml(state.mediaBase)}/originals/${encodeURIComponent(slug)}/${encodeURIComponent(val)}" alt="cover" onerror="this.closest('.cover-preview').style.display='none'" />`;
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
  const photos = data.photos || [];
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
          <div class="media-cell" onclick="pickCover('${escHtml(f.name)}')" title="${escHtml(f.name)}" style="cursor:pointer">
            <img src="${escHtml(f.url || '')}" alt="${escHtml(f.name)}" loading="lazy" />
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
            (f) => `
          <div class="media-cell" onclick="pickCover('video:0')" title="${escHtml(f.name)}">
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

// ── Media list ─────────────────────────────
function mediaCell(type, f, i, slug) {
  const ph = type === 'photo' ? `{{photo:${i}}}` : type === 'video' ? `{{video:${i}}}` : '{{music}}';
  const inner =
    type === 'photo'
      ? `<img src="${escHtml(f.url || '')}" alt="${escHtml(f.name)}" loading="lazy" />`
      : `<div class="media-cell-icon"><i class="ri-${type === 'video' ? 'video' : 'music'}-line"></i></div>`;
  const click =
    type === 'photo'
      ? `onclick="window.pickCover('${escHtml(f.name)}')"`
      : `onclick="window.insertPlaceholder('${escHtml(ph)}')"`;
  return `
    <div class="media-cell" ${click} draggable="true" data-ph="${escHtml(ph)}" title="${escHtml(f.name)} — ${t('editor.dragInsertHint')}">
      ${inner}
      <div class="media-cell-name">${escHtml(f.name)}</div>
      <button type="button" class="media-cell-insert" onclick="event.stopPropagation();window.insertPlaceholder('${escHtml(ph)}')" title="${t('editor.insert')}" aria-label="${t('editor.insert')} ${escHtml(f.name)}"><i class="ri-corner-down-left-line"></i></button>
      <button class="media-cell-del" onclick="event.stopPropagation();doDeleteMedia('${escHtml(slug)}','${escHtml(f.name)}','${type}s')" title="${t('editor.deleteMedia')}" aria-label="${t('editor.deleteMedia')}"><i class="ri-delete-bin-line"></i></button>
    </div>`;
}

function mediaGroup(title, count, insertPh, cellsHtml) {
  return `
    <div class="media-group-head">
      <span class="editor-section-title" style="margin:0">${title} (${count})</span>
      <button type="button" class="btn btn-ghost btn-sm" onclick="window.insertPlaceholder('${escHtml(insertPh)}')">${t('editor.insertAll')}</button>
    </div>
    ${cellsHtml}`;
}

export async function loadExistingMedia(slug) {
  const el = document.getElementById('existing-media');
  if (!el) return;
  el.innerHTML = `<p class="media-empty">${t('editor.loadMedia')}</p>`;
  try {
    const data = await mediaApi.list(slug);
    const photos = data.photos || [];
    const videos = data.videos || [];
    const music = data.music || [];
    window._editorMedia = { photos, videos, music };
    let html = `<div class="editor-section-title">${t('editor.existingMedia')}</div>`;
    if (!photos.length && !videos.length && !music.length) {
      html += `<p class="media-empty">${t('editor.noMedia')}</p>`;
    } else {
      if (photos.length) {
        html += mediaGroup(
          t('editor.photos'),
          photos.length,
          '{{gallery}}',
          `<div class="media-grid">${photos.map((f, i) => mediaCell('photo', f, i, slug)).join('')}</div>`,
        );
      }
      if (videos.length) {
        html += mediaGroup(
          t('editor.placeholderVideos'),
          videos.length,
          '{{videos}}',
          `<div class="media-grid" style="margin-top:8px">${videos.map((f, i) => mediaCell('video', f, i, slug)).join('')}</div>`,
        );
      }
      if (music.length) {
        html += mediaGroup(
          t('editor.music'),
          music.length,
          '{{music}}',
          `<div class="media-grid" style="margin-top:8px">${music.map((f, i) => mediaCell('music', f, i, slug)).join('')}</div>`,
        );
      }
    }
    el.innerHTML = html;
    renderBlocksFromBody();
  } catch {
    el.innerHTML = `<p class="media-empty">${t('editor.loadError')}</p>`;
  }
}

window.loadExistingMedia = loadExistingMedia;

window.doDeleteMedia = (slug, file, type) => {
  modalConfirm(t('editor.mediaDeleteConfirm', { file }), '', async () => {
    try {
      await mediaApi.delete(slug, file, type);
      window.checkDirty && window.checkDirty();
      await loadExistingMedia(slug);
      toast(t('common.copied'), 'success');
    } catch (err) {
      toast(t('common.deleteFailed') + ': ' + err.message, 'error');
    }
  });
};
