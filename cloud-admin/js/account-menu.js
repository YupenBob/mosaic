/**
 * Account menu and the persistent "write" action.
 *
 * Keeps the topbar quiet: appearance, language, site link and sign-out live in
 * one popover instead of four competing icons. The menu is keyboard-operable
 * and restores focus to its trigger.
 */
import { setLang } from './i18n.js?v=1';
import { getThemePref, setTheme } from './theme.js?v=1';
import { state } from './state.js?v=1';

let wired = false;
let lastFocus = null;

function menuEls() {
  return {
    button: document.getElementById('account-btn'),
    menu: document.getElementById('account-menu'),
    signout: document.getElementById('account-signout'),
    site: document.getElementById('account-site-link'),
  };
}

export function closeAccountMenu({ restoreFocus = false } = {}) {
  const { button, menu } = menuEls();
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  button?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) (lastFocus || button)?.focus();
}

export function syncAccountMenu() {
  const { button, menu, site } = menuEls();
  if (!button || !menu) return;
  const title = state.config?.title || 'Mosaic';
  const name = document.querySelector('.account-menu-name');
  const avatar = document.getElementById('account-avatar');
  if (name) name.textContent = title;
  if (avatar) avatar.textContent = String(title).trim().charAt(0).toUpperCase() || 'M';

  const theme = getThemePref();
  menu.querySelectorAll('[data-theme-pref]').forEach((item) => {
    const active = item.dataset.themePref === theme;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  const lang = localStorage.getItem('mosaic_admin_lang') || 'zh-CN';
  menu.querySelectorAll('[data-lang]').forEach((item) => {
    const active = item.dataset.lang === lang;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-checked', active ? 'true' : 'false');
  });

  if (site) {
    const url = state.siteUrl || state.config?.url || '';
    if (url) {
      site.href = url;
      site.hidden = false;
    } else {
      site.hidden = true;
    }
  }
}

function openAccountMenu() {
  const { button, menu } = menuEls();
  if (!button || !menu) return;
  lastFocus = document.activeElement;
  syncAccountMenu();
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => menu.querySelector('a:not([hidden]), button')?.focus());
}

export function setupAccountMenu() {
  if (wired) return;
  wired = true;
  const { button, menu, signout } = menuEls();

  button?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu.hidden) openAccountMenu();
    else closeAccountMenu({ restoreFocus: true });
  });

  menu?.addEventListener('click', (event) => {
    const theme = event.target.closest('[data-theme-pref]');
    if (theme) {
      setTheme(theme.dataset.themePref);
      syncAccountMenu();
      return;
    }
    const lang = event.target.closest('[data-lang]');
    if (lang && lang.dataset.lang !== (localStorage.getItem('mosaic_admin_lang') || 'zh-CN')) {
      setLang(lang.dataset.lang);
      closeAccountMenu({ restoreFocus: true });
      return;
    }
  });

  signout?.addEventListener('click', () => {
    closeAccountMenu();
    window.mosaicLogout?.();
  });

  document.getElementById('topbar-create')?.addEventListener('click', () => {
    location.hash = 'editor';
  });

  document.addEventListener('click', (event) => {
    if (!menu || menu.hidden) return;
    if (event.target.closest('.account-menu-wrap')) return;
    closeAccountMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAccountMenu({ restoreFocus: true });
  });
  window.addEventListener('mosaic:config', syncAccountMenu);
  window.addEventListener('mosaic:site-url', syncAccountMenu);
  syncAccountMenu();
}
