/**
 * Global search, command palette and keyboard shortcuts.
 *
 * Extracted from admin.js so the entry point only owns auth/shell wiring.
 * Search and palette share the cached post list; both close on navigation.
 */
import { posts as postsApi } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=1';
import { escHtml, debounce } from './ui.js?v=1';
import { cycleTheme } from './theme.js?v=1';
import { pages } from './router.js';
import { isConfigDirty } from './config/form.js?v=1';

let postsLoaded = false;

async function ensurePostsLoaded() {
  if (postsLoaded && state.posts.length) return;
  try {
    const result = await postsApi.list();
    state.posts = result.posts || result || [];
    postsLoaded = true;
  } catch {
    /* search degrades to commands only */
  }
}

// ── Global search ──────────────────────────
function renderGlobalSearch(query) {
  const popover = document.getElementById('global-search-popover');
  if (!popover) return;
  const q = String(query || '')
    .toLowerCase()
    .trim();
  if (!q) {
    popover.classList.remove('open');
    return;
  }
  const posts = state.posts
    .filter((post) => (post.title || '').toLowerCase().includes(q) || post.slug.toLowerCase().includes(q))
    .slice(0, 8);
  const commands = [
    { icon: 'ri-add-line', title: t('command.newPost'), key: 'new' },
    { icon: 'ri-play-fill', title: t('command.triggerBuild'), key: 'build' },
    { icon: 'ri-settings-line', title: t('command.openConfig'), key: 'config' },
  ];
  let html = '';
  if (posts.length) {
    html +=
      `<div class="gs-section-label">${t('nav.posts')}</div>` +
      posts
        .map(
          (post) => `
      <button class="gs-item" data-gs-post="${escHtml(post.slug)}">
        <i class="ri-article-line" aria-hidden="true"></i>
        <span class="gs-title">${escHtml(post.title || post.slug)}</span>
        <span class="gs-meta">${escHtml(post.slug)}</span>
      </button>`,
        )
        .join('');
  }
  html +=
    `<div class="gs-section-label">${t('command.actions')}</div>` +
    commands
      .map(
        (command) => `
    <button class="gs-item" data-gs-cmd="${command.key}">
      <i class="${command.icon}" aria-hidden="true"></i>
      <span class="gs-title">${command.title}</span>
    </button>`,
      )
      .join('');
  if (!posts.length && q) html = `<div class="gs-empty">${t('common.noResults')}</div>`;
  popover.innerHTML = html;
  popover.classList.add('open');
}

/** Wire the topbar global search input and its popover. */
export function setupGlobalSearch() {
  const input = document.getElementById('global-search-input');
  const wrap = document.getElementById('global-search');
  if (!input || !wrap) return;
  const popover = document.createElement('div');
  popover.className = 'global-search-popover';
  popover.id = 'global-search-popover';
  wrap.appendChild(popover);

  const onQuery = debounce(async (value) => {
    await ensurePostsLoaded();
    renderGlobalSearch(value);
  }, 150);
  input.addEventListener('input', () => onQuery(input.value));
  input.addEventListener('focus', () => {
    if (input.value) renderGlobalSearch(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      popover.classList.remove('open');
      input.blur();
      return;
    }
    if (event.key === 'Enter') {
      popover.querySelector('.gs-item')?.click();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const items = [...popover.querySelectorAll('.gs-item')];
      const index = items.findIndex((el) => el.classList.contains('active'));
      items.forEach((el) => el.classList.remove('active'));
      items[Math.min(index + 1, items.length - 1)]?.classList.add('active');
    }
  });
  popover.addEventListener('mousedown', (event) => event.preventDefault());
  popover.addEventListener('click', (event) => {
    const postButton = event.target.closest('[data-gs-post]');
    if (postButton) {
      popover.classList.remove('open');
      input.value = '';
      location.hash = 'editor&slug=' + encodeURIComponent(postButton.dataset.gsPost);
      return;
    }
    const commandButton = event.target.closest('[data-gs-cmd]');
    if (commandButton) {
      popover.classList.remove('open');
      input.value = '';
      if (commandButton.dataset.gsCmd === 'new') location.hash = 'editor';
      else if (commandButton.dataset.gsCmd === 'build') window.doTriggerBuild();
      else if (commandButton.dataset.gsCmd === 'config') location.hash = 'config';
    }
  });
  document.addEventListener('click', (event) => {
    if (!wrap.contains(event.target)) popover.classList.remove('open');
  });
}

// ── Command palette ────────────────────────
/**
 * Configure and open the Ctrl/Cmd+K command palette.
 * @param {{onSavePost?:() => void}} [hooks] App-level actions.
 */
export function openCommandPalette(hooks = {}) {
  if (document.querySelector('.cmd-overlay')) {
    closeCommandPalette();
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'cmd-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('command.placeholder'));
  overlay.innerHTML = `
    <div class="cmd-box">
      <div class="cmd-input-wrap">
        <i class="ri-search-line" aria-hidden="true"></i>
        <input type="text" id="cmd-input" placeholder="${t('command.placeholder')}" autocomplete="off" aria-label="${t('command.placeholder')}" />
        <kbd>ESC</kbd>
      </div>
      <div class="cmd-list" id="cmd-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#cmd-input');
  input.focus();

  const pageItems = () =>
    Object.entries(pages)
      .filter(([name, page]) => name !== 'deploy' && page.label)
      .map(([name, page]) => ({
        icon: page.icon,
        title: page.label(),
        meta: '#',
        go: () => {
          location.hash = name;
        },
      }));

  const actionItems = () => [
    {
      icon: 'ri-add-line',
      title: t('command.newPost'),
      meta: 'N',
      go: () => {
        location.hash = 'editor';
      },
    },
    { icon: 'ri-play-fill', title: t('command.triggerBuild'), meta: '', go: () => window.doTriggerBuild() },
    {
      icon: 'ri-save-line',
      title: t('command.savePost'),
      meta: '⌘⏎',
      go: () => state.page === 'editor' && hooks.onSavePost?.(),
    },
    { icon: 'ri-contrast-2-line', title: t('command.toggleTheme'), meta: '', go: () => cycleTheme() },
  ];

  const postItems = () =>
    state.posts.map((post) => ({
      icon: 'ri-article-line',
      title: post.title || post.slug,
      meta: post.slug,
      go: () => {
        location.hash = 'editor&slug=' + encodeURIComponent(post.slug);
      },
    }));

  const match = (item, q) =>
    !q ||
    String(item.title).toLowerCase().includes(q) ||
    String(item.meta || '')
      .toLowerCase()
      .includes(q);

  const itemHtml = (item) =>
    `<button class="cmd-item" data-idx="${item.idx}"><i class="${item.icon}" aria-hidden="true"></i><span class="cmd-label">${escHtml(item.title)}</span>${item.meta ? `<span class="cmd-kbd">${escHtml(item.meta)}</span>` : ''}</button>`;

  /** Items currently rendered, in visual order (used by click/Enter). */
  let currentItems = [];

  const render = (query) => {
    const q = query.toLowerCase().trim();
    let idx = 0;
    const numbered = (item) => ({ ...item, idx: idx++ });
    const pagesMatch = pageItems()
      .filter((item) => match(item, q))
      .map(numbered);
    const actionsMatch = actionItems()
      .filter((item) => match(item, q))
      .map(numbered);
    const postsMatch = postItems()
      .filter((item) => match(item, q))
      .slice(0, 6)
      .map(numbered);
    currentItems = [...pagesMatch, ...actionsMatch, ...postsMatch];
    let html = '';
    if (pagesMatch.length)
      html += `<div class="cmd-group-label">${t('command.pages')}</div>` + pagesMatch.map(itemHtml).join('');
    if (actionsMatch.length)
      html += `<div class="cmd-group-label">${t('command.actions')}</div>` + actionsMatch.map(itemHtml).join('');
    if (postsMatch.length)
      html += `<div class="cmd-group-label">${t('nav.posts')}</div>` + postsMatch.map(itemHtml).join('');
    if (!html) html = `<div class="cmd-empty">${t('command.noMatch')}</div>`;
    const list = overlay.querySelector('#cmd-list');
    list.innerHTML = html;
    list.querySelector('.cmd-item')?.classList.add('active');
  };

  const list = overlay.querySelector('#cmd-list');
  list.addEventListener('click', (event) => {
    const button = event.target.closest('.cmd-item');
    if (!button) return;
    overlay.remove();
    currentItems[Number(button.dataset.idx)]?.go();
  });

  render('');
  ensurePostsLoaded().then(() => {
    if (overlay.isConnected) render(input.value);
  });

  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (event) => {
    const items = [...overlay.querySelectorAll('.cmd-item')];
    const index = items.findIndex((el) => el.classList.contains('active'));
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items.forEach((el) => el.classList.remove('active'));
      items[Math.min(index + 1, items.length - 1)]?.classList.add('active');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items.forEach((el) => el.classList.remove('active'));
      items[Math.max(index - 1, 0)]?.classList.add('active');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      items.find((el) => el.classList.contains('active'))?.click();
    } else if (event.key === 'Escape') {
      overlay.remove();
    }
  });
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) overlay.remove();
  });
}

export function closeCommandPalette() {
  document.querySelector('.cmd-overlay')?.remove();
}

// ── Keyboard shortcuts ─────────────────────
/**
 * Global keyboard shortcuts and unsaved-changes guard.
 * @param {{onSavePost?:() => void}} [hooks]
 */
export function setupKeyboard(hooks = {}) {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommandPalette(hooks);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && state.page === 'editor' && !event.shiftKey) {
      event.preventDefault();
      hooks.onSavePost?.();
      return;
    }
    if (event.key === 'Escape') {
      closeCommandPalette();
      document.getElementById('global-search-popover')?.classList.remove('open');
      return;
    }
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      location.hash = 'editor';
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (state.editorDirty || isConfigDirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}
