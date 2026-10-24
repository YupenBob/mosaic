/**
 * Mosaic Cloud Admin — entry point.
 * Owns authentication, the app shell (topbar / mobile sidebar / i18n) and the
 * page router hand-off. Pollers, command palette and page modules live in
 * their own modules and are statically imported so the published bundle
 * (scripts/stage-admin.mjs) contains a single ESM entry.
 */
import { auth, getToken, setToken, config as configApi, setNavigationSignal, configureClient } from '../src/api.js';
import { t, setLang, onLangChange } from './i18n.js?v=1';
import { initTheme, cycleTheme } from './theme.js?v=1';
import { state } from './state.js?v=1';
import { toast } from './ui.js?v=1';
import { setupUploadZone } from './upload.js?v=1';
import { onHashChange, navigateTo, parseHash } from './router.js';
import { updateCoverPreview } from './editor.js?v=1';
import { startPollers, stopPollers } from './pollers.js';
import { setupGlobalSearch, setupKeyboard } from './command-palette.js';

// ── Auth ───────────────────────────────────
/** Show the login screen and tear down the authenticated shell. */
function showLogin() {
  state.pageScope?.dispose();
  setNavigationSignal(null);
  state.authStatus = 'expired';
  closeMobileNav();
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  setToken(null);
  stopPollers();
  requestAnimationFrame(() => document.getElementById('login-password')?.focus());
}

window.mosaicLogin = async () => {
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  if (!password) {
    errorEl.style.display = 'block';
    errorEl.textContent = t('login.error');
    document.getElementById('login-password')?.focus();
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
    hydrateConfig();
  } catch (err) {
    errorEl.style.display = 'block';
    errorEl.textContent = t('login.error') + ': ' + (err.message || '');
    document.getElementById('login-password')?.focus();
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
  btn.innerHTML = `<i class="${show ? 'ri-eye-off-line' : 'ri-eye-line'}" aria-hidden="true"></i>`;
  btn.setAttribute('aria-label', show ? t('login.hidePassword') : t('login.showPassword'));
};

/** Load client policy config once and notify capability-aware modules. */
function hydrateConfig() {
  configApi
    .get()
    .then((cfg) => {
      state.config = cfg;
      configureClient(cfg.admin);
      window.dispatchEvent(new CustomEvent('mosaic:config'));
      window.checkDirty && window.checkDirty();
    })
    .catch(() => {});
}

// ── Mobile sidebar ─────────────────────────
/** Toggle `inert`/`aria-hidden` so the closed drawer is not focusable/scanned. */
function applySidebarState(open) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const hidden = window.innerWidth <= 768 && !open;
  sidebar.toggleAttribute('inert', hidden);
  sidebar.setAttribute('aria-hidden', hidden ? 'true' : 'false');
}

function setMobileNav(open) {
  const body = document.body;
  const toggle = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  body.classList.toggle('sidebar-open', open);
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (backdrop) backdrop.hidden = !open;
  applySidebarState(open);
  if (open) document.querySelector('.sidebar .nav-item')?.focus();
  else if (document.activeElement?.closest?.('#sidebar')) toggle?.focus();
}

function closeMobileNav() {
  if (document.body.classList.contains('sidebar-open')) setMobileNav(false);
}

function setupMobileNav() {
  const toggle = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!toggle) return;
  applySidebarState(false);
  toggle.addEventListener('click', () => setMobileNav(!document.body.classList.contains('sidebar-open')));
  backdrop?.addEventListener('click', closeMobileNav);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMobileNav();
  });
  document.getElementById('sidebar-nav')?.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeMobileNav();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeMobileNav();
    applySidebarState(document.body.classList.contains('sidebar-open'));
  });
}

// ── Topbar wiring ──────────────────────────
function setupTopbar() {
  document.getElementById('topbar-theme-btn')?.addEventListener('click', cycleTheme);
  const langSelect = document.getElementById('topbar-lang');
  if (langSelect) {
    langSelect.value = localStorage.getItem('mosaic_admin_lang') || 'zh-CN';
    langSelect.addEventListener('change', () => setLang(langSelect.value));
  }
  document.getElementById('topbar-build-btn')?.addEventListener('click', (event) => {
    event.stopPropagation();
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
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });
  const langSelect = document.getElementById('topbar-lang');
  if (langSelect) langSelect.value = localStorage.getItem('mosaic_admin_lang') || 'zh-CN';
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
  setupMobileNav();
  setupGlobalSearch();
  setupKeyboard({
    onSavePost: () => state.page === 'editor' && window.doSavePost?.(),
  });
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
    hydrateConfig();
  } else {
    hideLoading();
    showLogin();
  }
}

window.addEventListener('hashchange', onHashChange);
window.addEventListener('mosaic:auth-expired', showLogin);

// Inline editor helpers rely on these globals.
window.updateCoverPreview = updateCoverPreview;

// Generic toast helper for inline handlers (kept for compatibility).
window.adminToast = toast;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
