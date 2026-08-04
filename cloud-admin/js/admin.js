/**
 * Mosaic Cloud Admin — entry point.
 * Router, auth, dirty banner, topbar chrome, global search, command palette,
 * keyboard shortcuts and unsaved-changes guard.
 */
import { auth, getToken, setToken, posts as postsApi, build } from '../src/api.js';
import { t, setLang, onLangChange } from './i18n.js';
import { initTheme, cycleTheme } from './theme.js';
import { state } from './state.js';
import { toast, modalConfirm, escHtml, debounce, formatTime } from './ui.js';
import { setupUploadZone } from './upload.js';

import renderDashboard, { dashboardSkeleton } from './dashboard.js';
import renderPosts, { postsSkeleton } from './posts.js';
import renderEditor, { editorSkeleton, updateCoverPreview } from './editor.js';
import renderBuild, { buildSkeleton } from './build.js';
import renderConfig, { configSkeleton } from './config.js';
import renderTaxonomy, { taxonomySkeleton } from './taxonomy.js';
import renderCleanup, { cleanupSkeleton } from './cleanup.js';
import renderTrash, { renderDeployRedirect, trashSkeleton } from './trash.js';

const pages = {
  dashboard: {
    render: renderDashboard,
    skeleton: dashboardSkeleton,
    label: () => t('nav.dashboard'),
    icon: 'ri-dashboard-line',
  },
  posts: { render: renderPosts, skeleton: postsSkeleton, label: () => t('nav.posts'), icon: 'ri-article-line' },
  editor: {
    render: renderEditor,
    skeleton: editorSkeleton,
    label: () => (state.params.slug ? t('nav.editor') + ' · ' + state.params.slug : t('nav.editor')),
    icon: 'ri-edit-line',
  },
  build: { render: renderBuild, skeleton: buildSkeleton, label: () => t('nav.build'), icon: 'ri-tools-line' },
  config: { render: renderConfig, skeleton: configSkeleton, label: () => t('nav.config'), icon: 'ri-settings-line' },
  taxonomy: {
    render: renderTaxonomy,
    skeleton: taxonomySkeleton,
    label: () => t('nav.taxonomy'),
    icon: 'ri-price-tag-3-line',
  },
  cleanup: { render: renderCleanup, skeleton: cleanupSkeleton, label: () => t('nav.cleanup'), icon: 'ri-broom-line' },
  trash: { render: renderTrash, skeleton: trashSkeleton, label: () => t('nav.trash'), icon: 'ri-delete-bin-6-line' },
  deploy: { render: () => renderDeployRedirect(), skeleton: null, label: () => 'Deploy', icon: 'ri-tools-line' },
};

let _dirtyPollTimer = null;
let _buildPollTimer = null;
let _lastHash = '';

// ── Router ─────────────────────────────────
function parseHash() {
  const raw = location.hash.replace('#', '') || 'dashboard';
  const [page, ...rest] = raw.split('&');
  return { page: page || 'dashboard', params: Object.fromEntries(new URLSearchParams(rest.join('&'))) };
}

function onHashChange() {
  const { page } = parseHash();
  // Unsaved-editor guard: intercept navigation away from the editor
  if (state.editorDirty && (state.page === 'editor' || page !== 'editor')) {
    const target = location.hash;
    // Revert to the editor hash; if already there, allow re-render
    if (target !== _lastHash) {
      history.replaceState(null, '', _lastHash || '#editor');
      modalConfirm(
        t('common.unsavedTitle'),
        t('common.unsavedMsg'),
        () => {
          state.editorDirty = false;
          location.hash = target;
        },
        { danger: false, okLabel: t('common.discard') },
      );
      return;
    }
  }
  navigateTo(page, parseHash().params);
}

function navigateTo(page, params) {
  if (state.abortController) state.abortController.abort();
  state.abortController = new AbortController();
  state.page = page;
  state.params = params || {};
  _lastHash = location.hash || '#' + page;
  updateNav(page);
  updateChrome(page);
  renderPage(page, state.abortController.signal);
}

function updateNav(page) {
  document.querySelectorAll('.nav-item[data-page]').forEach((a) => {
    a.classList.toggle('active', a.dataset.page === page);
  });
}

function updateChrome(page) {
  const label = pages[page]?.label() || t('common.unknown');
  const el = document.getElementById('topbar-page');
  if (el) el.textContent = label;
  document.title = `${label} — Mosaic Cloud Admin`;
}

async function renderPage(page, signal) {
  const m = document.getElementById('main-content');
  if (!m) return;
  const renderer = pages[page];
  if (!renderer) {
    if (!signal.aborted) {
      m.innerHTML = `<div class="page-anim" style="padding:80px 24px">${emptyPage()}</div>`;
    }
    return;
  }
  const skeleton = renderer.skeleton
    ? renderer.skeleton()
    : '<div class="page-anim" style="text-align:center;padding:60px"><i class="ri-loader-4-line" style="font-size:26px;animation:spin 1s linear infinite;color:var(--color-text-tertiary)"></i></div>';
  m.innerHTML = skeleton;
  try {
    const result = await renderer.render(signal);
    if (signal.aborted) return;
    m.innerHTML = typeof result === 'string' ? result : result.html;
    if (result?.onMount && !signal.aborted) await result.onMount();
  } catch (err) {
    if (signal.aborted) return;
    m.innerHTML = `<div class="page-anim"><h1>${t('common.error')}</h1><p class="error">${escHtml(err.message)}</p></div>`;
  }
}

function emptyPage() {
  const { title, desc, back } = {
    title: t('page404.title'),
    desc: t('page404.desc'),
    back: t('page404.back'),
  };
  return `<div class="empty-state"><i class="ri-compass-line"></i><h3>${title}</h3><p>${desc}</p><button class="btn btn-primary" onclick="location.hash='dashboard'">${back}</button></div>`;
}

// ── Auth ───────────────────────────────────
function showLogin() {
  state.authStatus = 'expired';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  setToken(null);
  stopPollers();
}

window.mosaicLogin = async () => {
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  if (!password) {
    errorEl.style.display = 'block';
    errorEl.textContent = t('login.error');
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span> ' + t('login.signing');
  errorEl.style.display = 'none';
  try {
    const { token } = await auth.login(password);
    setToken(token);
    state.authStatus = 'ok';
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    setupUploadZone();
    startPollers();
    onHashChange();
  } catch (err) {
    errorEl.style.display = 'block';
    errorEl.textContent = t('login.error') + ': ' + (err.message || '');
  } finally {
    btn.disabled = false;
    btn.textContent = t('login.btn');
  }
};

window.mosaicLogout = () => showLogin();

window.toggleLoginPassword = () => {
  const input = document.getElementById('login-password');
  const btn = document.getElementById('login-eye');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = `<i class="${show ? 'ri-eye-off-line' : 'ri-eye-line'}"></i>`;
  btn.setAttribute('aria-label', show ? t('login.hidePassword') : t('login.showPassword'));
};

// ── Dirty banner ───────────────────────────
function showDirtyBanner(count, last) {
  const b = document.getElementById('dirty-banner');
  if (!b) return;
  const ago = last ? t('dirty.ago', { time: formatTime(last) }) : '';
  document.getElementById('dirty-banner-text').textContent = t('dirty.text', { count, ago });
  b.style.display = 'flex';
  const badge = document.getElementById('nav-build-badge');
  if (badge) {
    badge.textContent = count;
    badge.style.display = '';
  }
}

function hideDirtyBanner() {
  const b = document.getElementById('dirty-banner');
  if (b) b.style.display = 'none';
  const badge = document.getElementById('nav-build-badge');
  if (badge) badge.style.display = 'none';
}

window.checkDirty = async () => {
  const token = getToken();
  if (!token || state.authStatus !== 'ok') return;
  const API = window.__API_BASE__ || '/api';
  try {
    const resp = await fetch(API + '/dirty', { headers: { Authorization: 'Bearer ' + token } });
    if (resp.ok) {
      const dirty = await resp.json();
      if (dirty.count > 0) showDirtyBanner(dirty.count, dirty.last);
      else hideDirtyBanner();
    }
  } catch {}
};

// ── Pollers ────────────────────────────────
function startPollers() {
  stopPollers();
  window.checkDirty();
  pollBuildStatus();
  loadSiteUrl();
  _dirtyPollTimer = setInterval(window.checkDirty, 60000);
  _buildPollTimer = setInterval(pollBuildStatus, 30000);
}

async function loadSiteUrl() {
  if (state.siteUrl) {
    const btn = document.getElementById('topbar-site-btn');
    if (btn) btn.href = state.siteUrl;
    return;
  }
  try {
    const API = window.__API_BASE__ || '/api';
    const resp = await fetch(API + '/config', { headers: { Authorization: 'Bearer ' + (getToken() || '') } });
    if (resp.ok) {
      const cfg = await resp.json();
      if (cfg.url) {
        state.siteUrl = cfg.url;
        state.mediaBase = cfg.mediaBase || state.mediaBase;
        const btn = document.getElementById('topbar-site-btn');
        if (btn) btn.href = cfg.url;
      }
    }
  } catch {}
}

function stopPollers() {
  if (_dirtyPollTimer) {
    clearInterval(_dirtyPollTimer);
    _dirtyPollTimer = null;
  }
  if (_buildPollTimer) {
    clearInterval(_buildPollTimer);
    _buildPollTimer = null;
  }
}

async function pollBuildStatus() {
  const dot = document.getElementById('topbar-build-dot');
  if (!dot) return;
  try {
    const s = await build.status().catch(() => null);
    if (!s || !s.status || s.status === 'unknown') {
      dot.className = 'status-dot';
      dot.title = '';
      window.setBuildTriggerStates && window.setBuildTriggerStates(false);
      return;
    }
    if (s.status === 'in_progress' || s.status === 'queued') {
      dot.className = 'status-dot busy';
      dot.title = t('build.running') + ' #' + (s.runNumber || '');
      window.setBuildTriggerStates && window.setBuildTriggerStates(true);
    } else if (s.conclusion === 'success') {
      dot.className = 'status-dot ok';
      dot.title = t('build.success');
      window.setBuildTriggerStates && window.setBuildTriggerStates(false);
    } else if (s.conclusion === 'failure') {
      dot.className = 'status-dot down';
      dot.title = t('build.failed');
      window.setBuildTriggerStates && window.setBuildTriggerStates(false);
    } else {
      dot.className = 'status-dot';
      dot.title = '';
      window.setBuildTriggerStates && window.setBuildTriggerStates(false);
    }
  } catch {}
}

// ── Global build trigger ───────────────────
window.setBuildTriggerStates = (running) => {
  const building = t('build.building');
  document.querySelectorAll('[data-build-trigger]').forEach((btn) => {
    if (running) {
      if (btn.dataset.restore === undefined) btn.dataset.restore = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-spinner"></span> ' + building;
    } else {
      btn.disabled = false;
      if (btn.dataset.restore !== undefined) {
        btn.innerHTML = btn.dataset.restore;
        delete btn.dataset.restore;
      }
    }
  });
  const tb = document.getElementById('topbar-build-btn');
  if (tb) {
    if (running) {
      if (tb.dataset.restore === undefined) tb.dataset.restore = tb.innerHTML;
      tb.disabled = true;
      tb.innerHTML = '<span class="btn-spinner"></span>';
    } else {
      tb.disabled = false;
      if (tb.dataset.restore !== undefined) {
        tb.innerHTML = tb.dataset.restore;
        delete tb.dataset.restore;
      }
    }
  }
  const dot = document.getElementById('topbar-build-dot');
  if (dot) dot.className = 'status-dot' + (running ? ' busy' : '');
};

window.doTriggerBuild = async () => {
  const loading = t('common.loading');
  document.querySelectorAll('[data-build-trigger]').forEach((btn) => {
    if (btn.dataset.restore === undefined) btn.dataset.restore = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span> ' + loading;
  });
  const tb = document.getElementById('topbar-build-btn');
  if (tb) {
    if (tb.dataset.restore === undefined) tb.dataset.restore = tb.innerHTML;
    tb.disabled = true;
    tb.innerHTML = '<span class="btn-spinner"></span>';
  }
  try {
    const result = await build.trigger();
    hideDirtyBanner();
    toast(t('build.triggered', { method: result.method || 'push' }), 'success', 5000);
    if (result.wfError) toast(t('build.fallbackUsed', { error: result.wfError }), 'info', 6000);
    window.setBuildTriggerStates(true);
    if (location.hash !== '#build') location.hash = 'build';
    pollBuildStatus();
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('already in progress') || msg.includes('BUILD_RUNNING')) {
      toast(t('build.alreadyRunning'), 'info', 5000);
      window.setBuildTriggerStates(true);
      if (location.hash !== '#build') location.hash = 'build';
    } else {
      toast(t('build.triggerFailed') + ': ' + msg, 'error', 8000);
      window.setBuildTriggerStates(false);
    }
  }
};

// ── Global search ──────────────────────────
let _searchPostsLoaded = false;

async function ensurePostsLoaded() {
  if (_searchPostsLoaded && state.posts.length) return;
  try {
    const r = await postsApi.list();
    state.posts = r.posts || r || [];
    _searchPostsLoaded = true;
  } catch {}
}

function renderGlobalSearch(q) {
  const pop = document.getElementById('global-search-popover');
  if (!pop) return;
  q = (q || '').toLowerCase().trim();
  if (!q) {
    pop.classList.remove('open');
    return;
  }
  const posts = state.posts
    .filter((p) => (p.title || '').toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
    .slice(0, 8);
  const commands = [
    { icon: 'ri-add-line', title: t('command.newPost'), meta: 'N', key: 'new' },
    { icon: 'ri-play-fill', title: t('command.triggerBuild'), meta: '', key: 'build' },
    { icon: 'ri-settings-line', title: t('command.openConfig'), meta: '', key: 'config' },
  ];
  let html = '';
  if (posts.length) {
    html +=
      `<div class="gs-section-label">${t('nav.posts')}</div>` +
      posts
        .map(
          (p) => `
      <button class="gs-item" data-gs-post="${escHtml(p.slug)}">
        <i class="ri-article-line"></i>
        <span class="gs-title">${escHtml(p.title || p.slug)}</span>
        <span class="gs-meta">${escHtml(p.slug)}</span>
      </button>`,
        )
        .join('');
  }
  html +=
    `<div class="gs-section-label">${t('command.actions')}</div>` +
    commands
      .map(
        (c) => `
    <button class="gs-item" data-gs-cmd="${c.key}">
      <i class="${c.icon}"></i>
      <span class="gs-title">${c.title}</span>
      ${c.meta ? `<span class="gs-meta"><kbd style="font-family:var(--font-mono);font-size:10px;color:var(--color-text-tertiary)">${c.meta}</kbd></span>` : ''}
    </button>`,
      )
      .join('');
  if (!posts.length && q) html = `<div class="gs-empty">${t('common.noResults')}</div>`;
  pop.innerHTML = html;
  pop.classList.add('open');
}

function setupGlobalSearch() {
  const input = document.getElementById('global-search-input');
  const wrap = document.getElementById('global-search');
  if (!input) return;
  const pop = document.createElement('div');
  pop.className = 'global-search-popover';
  pop.id = 'global-search-popover';
  wrap.appendChild(pop);

  const onQuery = debounce(async (v) => {
    await ensurePostsLoaded();
    renderGlobalSearch(v);
  }, 150);
  input.addEventListener('input', () => onQuery(input.value));
  input.addEventListener('focus', () => {
    if (input.value) renderGlobalSearch(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      pop.classList.remove('open');
      input.blur();
    }
    if (e.key === 'Enter') {
      const first = pop.querySelector('.gs-item');
      if (first) first.click();
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const items = [...pop.querySelectorAll('.gs-item')];
      const idx = items.findIndex((el) => el.classList.contains('active'));
      items.forEach((el) => el.classList.remove('active'));
      const next = items[Math.min(idx + 1, items.length - 1)];
      next && next.classList.add('active');
    }
  });
  pop.addEventListener('mousedown', (e) => e.preventDefault());
  pop.addEventListener('click', (e) => {
    const postBtn = e.target.closest('[data-gs-post]');
    if (postBtn) {
      pop.classList.remove('open');
      input.value = '';
      location.hash = 'editor&slug=' + encodeURIComponent(postBtn.dataset.gsPost);
      return;
    }
    const cmdBtn = e.target.closest('[data-gs-cmd]');
    if (cmdBtn) {
      pop.classList.remove('open');
      input.value = '';
      if (cmdBtn.dataset.gsCmd === 'new') location.hash = 'editor';
      else if (cmdBtn.dataset.gsCmd === 'build') window.doTriggerBuild();
      else if (cmdBtn.dataset.gsCmd === 'config') location.hash = 'config';
    }
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) pop.classList.remove('open');
  });
}

// ── Command palette ────────────────────────
function openCommandPalette() {
  const existing = document.querySelector('.cmd-overlay');
  if (existing) {
    closeCommandPalette();
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'cmd-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="cmd-box">
      <div class="cmd-input-wrap">
        <i class="ri-search-line"></i>
        <input type="text" id="cmd-input" placeholder="${t('command.placeholder')}" autocomplete="off" />
        <kbd style="font-family:var(--font-mono);font-size:10px;color:var(--color-text-tertiary)">ESC</kbd>
      </div>
      <div class="cmd-list" id="cmd-list"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#cmd-input');
  input.focus();
  renderCmdList('');

  function renderCmdList(q) {
    q = q.toLowerCase().trim();
    const list = overlay.querySelector('#cmd-list');
    const pageItems = Object.entries(pages)
      .filter(([name, p]) => name !== 'deploy' && p.label)
      .map(([name, p]) => ({
        icon: p.icon,
        title: p.label(),
        meta: '#',
        go: () => {
          location.hash = name;
        },
      }));
    const actions = [
      {
        icon: 'ri-add-line',
        title: t('command.newPost'),
        meta: 'N',
        go: () => {
          location.hash = 'editor';
        },
      },
      { icon: 'ri-play-fill', title: t('command.triggerBuild'), go: () => window.doTriggerBuild() },
      {
        icon: 'ri-save-line',
        title: t('command.savePost'),
        meta: '⌘⏎',
        go: () => state.page === 'editor' && window.doSavePost && window.doSavePost(),
      },
      { icon: 'ri-contrast-2-line', title: t('command.toggleTheme'), go: () => cycleTheme() },
    ];
    const postItems = state.posts.map((p) => ({
      icon: 'ri-article-line',
      title: p.title || p.slug,
      meta: p.slug,
      go: () => {
        location.hash = 'editor&slug=' + encodeURIComponent(p.slug);
      },
    }));
    const match = (item) => !q || item.title.toLowerCase().includes(q) || item.meta.toLowerCase().includes(q);
    const pagesMatch = pageItems.filter(match);
    const actionsMatch = actions.filter(match);
    const postsMatch = postItems.filter(match).slice(0, 6);
    let html = '';
    if (pagesMatch.length)
      html += `<div class="cmd-group-label">${t('command.pages')}</div>` + pagesMatch.map((i) => cmdItem(i)).join('');
    if (actionsMatch.length)
      html +=
        `<div class="cmd-group-label">${t('command.actions')}</div>` + actionsMatch.map((i) => cmdItem(i)).join('');
    if (postsMatch.length)
      html += `<div class="cmd-group-label">${t('nav.posts')}</div>` + postsMatch.map((i) => cmdItem(i)).join('');
    if (!html) html = `<div class="cmd-empty">${t('command.noMatch')}</div>`;
    list.innerHTML = html;
    list.querySelectorAll('.cmd-item').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = Number(el.dataset.idx);
        const all = getAllItems();
        if (all[idx]) {
          overlay.remove();
          all[idx].go();
        }
      });
    });
    list.querySelector('.cmd-item')?.classList.add('active');
  }

  function cmdItem(item) {
    return `<button class="cmd-item" data-idx="${getAllItems().length}"><i class="${item.icon}"></i><span class="cmd-label">${escHtml(item.title)}</span>${item.meta ? `<span class="cmd-kbd">${escHtml(item.meta)}</span>` : ''}</button>`;
  }

  function getAllItems() {
    const q = input.value;
    const pageItems = Object.entries(pages)
      .filter(([n, p]) => n !== 'deploy' && p.label)
      .map(([n, p]) => ({
        title: p.label(),
        meta: '#',
        go: () => {
          location.hash = n;
        },
      }));
    const actions = [
      {
        title: t('command.newPost'),
        meta: 'N',
        go: () => {
          location.hash = 'editor';
        },
      },
      { title: t('command.triggerBuild'), meta: '', go: () => window.doTriggerBuild() },
      {
        title: t('command.savePost'),
        meta: '⌘⏎',
        go: () => state.page === 'editor' && window.doSavePost && window.doSavePost(),
      },
      { title: t('command.toggleTheme'), meta: '', go: () => cycleTheme() },
    ];
    const postsM = state.posts.map((p) => ({
      title: p.title || p.slug,
      meta: p.slug,
      go: () => {
        location.hash = 'editor&slug=' + encodeURIComponent(p.slug);
      },
    }));
    return [...pageItems, ...actions, ...postsM].filter(
      (i) => !q || i.title.toLowerCase().includes(q) || i.meta.toLowerCase().includes(q),
    );
  }

  input.addEventListener('input', () => {
    renderCmdList(input.value);
  });
  input.addEventListener('keydown', (e) => {
    const items = [...overlay.querySelectorAll('.cmd-item')];
    const idx = items.findIndex((el) => el.classList.contains('active'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items.forEach((el) => el.classList.remove('active'));
      items[Math.min(idx + 1, items.length - 1)]?.classList.add('active');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items.forEach((el) => el.classList.remove('active'));
      items[Math.max(idx - 1, 0)]?.classList.add('active');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const active = items.find((el) => el.classList.contains('active'));
      active?.click();
    } else if (e.key === 'Escape') {
      overlay.remove();
    }
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

function closeCommandPalette() {
  document.querySelector('.cmd-overlay')?.remove();
}

// ── Keyboard shortcuts ─────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.page === 'editor' && !e.shiftKey) {
      e.preventDefault();
      window.doSavePost && window.doSavePost();
      return;
    }
    if (e.key === 'Escape') {
      closeCommandPalette();
      document.getElementById('global-search-popover')?.classList.remove('open');
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      location.hash = 'editor';
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.editorDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// ── Topbar wiring ──────────────────────────
function setupTopbar() {
  document.getElementById('topbar-theme-btn').addEventListener('click', cycleTheme);
  const langSel = document.getElementById('topbar-lang');
  langSel.value = localStorage.getItem('mosaic_admin_lang') || 'zh-CN';
  langSel.addEventListener('change', () => setLang(langSel.value));
  document.getElementById('topbar-build-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    window.doTriggerBuild();
  });
}

// ── i18n hooks ─────────────────────────────
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  const langSel = document.getElementById('topbar-lang');
  if (langSel) langSel.value = localStorage.getItem('mosaic_admin_lang') || 'zh-CN';
}

onLangChange(() => {
  applyStaticI18n();
  const { page, params } = parseHash();
  navigateTo(page, params);
});

// ── Init ───────────────────────────────────
async function init() {
  const loadingEl = document.getElementById('loading-screen');
  const hideLoading = () => {
    if (loadingEl) loadingEl.style.display = 'none';
  };
  applyStaticI18n();
  initTheme();
  setupTopbar();
  setupGlobalSearch();
  setupKeyboard();
  setTimeout(hideLoading, 5000);

  const token = getToken();
  if (token) {
    try {
      await auth.refresh();
      state.authStatus = 'ok';
    } catch {
      hideLoading();
      showLogin();
      return;
    }
    hideLoading();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    setupUploadZone();
    startPollers();
    onHashChange();
  } else {
    hideLoading();
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }
}

window.addEventListener('hashchange', onHashChange);
window.addEventListener('mosaic:auth-expired', showLogin);
window.addEventListener('mosaic:dirty', (e) => {
  const d = e.detail || {};
  if (d.count > 0) showDirtyBanner(d.count, d.last);
  else hideDirtyBanner();
});

// Expose updateCoverPreview for editor inline use
window.updateCoverPreview = updateCoverPreview;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
