import { setNavigationSignal } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=1';
import { createPageScope } from './lifecycle.js';
import { modalConfirm, escHtml } from './ui.js?v=1';
import renderDashboard, { dashboardSkeleton } from './dashboard.js?v=1';
import renderPosts, { postsSkeleton } from './posts.js?v=1';
import renderEditor, { editorSkeleton } from './editor.js?v=1';
import renderBuild, { buildSkeleton } from './build.js?v=1';
import renderConfig, { configSkeleton } from './config.js?v=1';
import renderTaxonomy, { taxonomySkeleton } from './taxonomy.js?v=1';
import renderCleanup, { cleanupSkeleton } from './cleanup.js?v=1';
import renderTrash, { renderDeployRedirect, trashSkeleton } from './trash.js?v=1';

export const pages = {
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

let _lastHash = '';

// ── Router ─────────────────────────────────
export function parseHash() {
  const raw = location.hash.replace('#', '') || 'dashboard';
  const [page, ...rest] = raw.split('&');
  return { page: page || 'dashboard', params: Object.fromEntries(new URLSearchParams(rest.join('&'))) };
}

export function onHashChange() {
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

export function navigateTo(page, params) {
  state.pageScope?.dispose();
  state.pageScope = createPageScope();
  state.abortController = state.pageScope;
  setNavigationSignal(state.pageScope.signal);
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
    if (result?.onUnmount) state.pageScope.own(result.onUnmount);
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
