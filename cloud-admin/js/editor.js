/**
 * Editor page — three-pane post editor with Markdown preview, autosave
 * drafts, cover picker, stats section and the media panel.
 */
import { posts as postsApi, media as mediaApi } from '../src/api.js';
import { t } from './i18n.js';
import { state } from './state.js';
import { escHtml, toast, modalConfirm, loadLib, openModal, closeModal } from './ui.js';

const MARKED_URL = 'js/vendor/marked.min.js';
const PURIFY_URL = 'js/vendor/purify.min.js';
const layouts = ['default', 'video-first', 'gallery-first', 'music-first'];

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
            <label class="field">
              <span class="field-label">${t('editor.layout')}</span>
              <select id="fm-layout" class="select">${layouts.map((l) => `<option value="${l}" ${fmv('layout') === l ? 'selected' : ''}>${l}</option>`).join('')}</select>
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
            <textarea id="fm-body" spellcheck="false" aria-label="${t('editor.body')}">${escHtml(body)}</textarea>
            <div class="markdown-preview hidden" id="fm-preview"></div>
          </div>

          <div class="editor-media-panel">
            <h3 class="media-panel-collapse" onclick="toggleMediaPanel()"><i class="ri-upload-cloud-2-line"></i> ${t('editor.mediaPanel')} <i class="ri-arrow-down-s-line" id="media-panel-caret" style="margin-left:auto"></i></h3>
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
    layout: document.getElementById('fm-layout')?.value || 'default',
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
    '#fm-title, #fm-date, #fm-category, #fm-tags, #fm-desc, #fm-layout, #fm-cover, #fm-views, #fm-likes, #fm-slug, #fm-body',
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
  set('fm-layout', d.layout || 'default');
  set('fm-cover', d.cover || '');
  set('fm-views', d.views || 0);
  set('fm-likes', d.likes || 0);
  set('fm-body', d.body || '');
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
    layout: document.getElementById('fm-layout').value,
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
  const ta = document.getElementById('fm-body');
  if (!ta) return;
  const start = ta.selectionStart,
    end = ta.selectionEnd;
  const selected = ta.value.slice(start, end) || placeholder;
  ta.setRangeText(before + selected + after, start, end, 'end');
  ta.dispatchEvent(new Event('input'));
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
  const ta = document.getElementById('fm-body');
  const preview = document.getElementById('fm-preview');
  if (!ta || !preview) return;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  ta.style.display = mode === 'preview' ? 'none' : '';
  preview.classList.toggle('hidden', mode !== 'preview' && mode !== 'split');
  preview.style.display = mode === 'preview' || mode === 'split' ? 'block' : 'none';
  if (mode === 'split') {
    ta.style.width = '50%';
    ta.style.float = 'left';
    ta.style.borderRight = '1px solid var(--color-border-light)';
    preview.style.width = '50%';
    preview.style.float = 'right';
    preview.style.minHeight = ta.offsetHeight + 'px';
  } else {
    ta.style.width = '100%';
    ta.style.float = 'none';
    ta.style.borderRight = 'none';
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
  let html = window.marked.parse(raw, { async: false, breaks: true });
  html = window.DOMPurify.sanitize(html);
  // Resolve relative media paths against the originals bucket for preview
  if (slug) {
    const base = (state.mediaBase || '').replace(/\/$/, '');
    html = html.replace(
      /(src|href)="((?:photos|videos|covers)\/[^"]+)"/g,
      (m, attr, path) => `${attr}="${base}/originals/${encodeURIComponent(slug)}/${path}"`,
    );
  }
  preview.innerHTML = html;
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
export async function loadExistingMedia(slug) {
  const el = document.getElementById('existing-media');
  if (!el) return;
  el.innerHTML = `<p class="media-empty">${t('editor.loadMedia')}</p>`;
  try {
    const data = await mediaApi.list(slug);
    let html = `<div class="editor-section-title">${t('editor.existingMedia')}</div>`;
    const photos = data.photos || [];
    const videos = data.videos || [];
    if (!photos.length && !videos.length) {
      html += `<p class="media-empty">${t('editor.noMedia')}</p>`;
    } else {
      if (photos.length) {
        html +=
          '<div class="media-grid">' +
          photos
            .map(
              (f) => `
          <div class="media-cell" onclick="window.pickCover('${escHtml(f.name)}')" title="${escHtml(f.name)}">
            <img src="${escHtml(f.url || '')}" alt="${escHtml(f.name)}" loading="lazy" />
            <div class="media-cell-name">${escHtml(f.name)}</div>
            <button class="media-cell-del" onclick="event.stopPropagation();doDeleteMedia('${escHtml(slug)}','${escHtml(f.name)}','photos')" title="${t('editor.deleteMedia')}" aria-label="${t('editor.deleteMedia')}"><i class="ri-delete-bin-line"></i></button>
          </div>`,
            )
            .join('') +
          '</div>';
      }
      if (videos.length) {
        html +=
          '<div class="media-grid" style="margin-top:8px">' +
          videos
            .map(
              (f) => `
          <div class="media-cell" title="${escHtml(f.name)}">
            <div class="media-cell-icon"><i class="ri-video-line"></i></div>
            <div class="media-cell-name">${escHtml(f.name)}</div>
            <button class="media-cell-del" onclick="event.stopPropagation();doDeleteMedia('${escHtml(slug)}','${escHtml(f.name)}','videos')" title="${t('editor.deleteMedia')}" aria-label="${t('editor.deleteMedia')}"><i class="ri-delete-bin-line"></i></button>
          </div>`,
            )
            .join('') +
          '</div>';
      }
    }
    el.innerHTML = html;
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
