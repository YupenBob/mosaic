/**
 * Frontend theme: open modes (auto / light / dark) + accent palettes
 * (blue / violet / emerald / rose / amber / slate), persisted in localStorage
 * and applied before first paint by the inline bootstrap in each layout head.
 *
 * `data-theme` holds the RESOLVED scheme (`light` | `dark`) because every
 * token/CSS rule keys off it; `data-theme-mode` holds the visitor preference
 * (`auto` | `light` | `dark`); `data-accent` holds the palette name.
 *
 * Backward compatible: `initTheme` / `applyTheme` / `cycleTheme` keep their
 * old exports (the simple post-page button still uses `cycleTheme`).
 *
 * @module theme
 */
import { t } from './data.js';
import { animateIn, animateOut } from './motion/index.js';

const THEME_KEY = 'mosaic_theme';
const ACCENT_KEY = 'mosaic_accent';
const MODES = ['auto', 'light', 'dark'];
const ACCENTS = ['blue', 'violet', 'emerald', 'rose', 'amber', 'slate'];
const THEME_COLOR = { light: '#f5f5f7', dark: '#1c1c1e' };

let systemListenerAttached = false;

const isValidMode = (mode) => MODES.includes(mode);
const isValidAccent = (accent) => ACCENTS.includes(accent);
const rootEl = () => document.documentElement;

function systemDark() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/**
 * Resolve a mode preference (`auto` follows the OS) to a concrete scheme.
 * @param {string} [mode]
 * @returns {'light'|'dark'}
 */
export function resolveThemeMode(mode = 'auto') {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemDark() ? 'dark' : 'light';
}

/** Read the theme config injected by the SSG (defaults are safe when absent). */
function themeConfig() {
  const cfg = (typeof window === 'undefined' ? null : window.__MOSAIC_CONFIG?.themeMode) || {};
  return {
    defaultMode: isValidMode(cfg.default) ? cfg.default : 'auto',
    accent: isValidAccent(cfg.accent) ? cfg.accent : 'blue',
    allowVisitorToggle: cfg.allowVisitorToggle !== false,
    showMenu: cfg.showMenu !== false,
  };
}

function readStored(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: keep the in-memory state */
  }
}

/**
 * Current theme state as reflected on `<html>`.
 * @returns {{ mode: string, resolved: 'light'|'dark', accent: string }}
 */
export function getThemeState() {
  const el = rootEl();
  const resolved = el.dataset.theme === 'dark' ? 'dark' : 'light';
  return {
    mode: isValidMode(el.dataset.themeMode) ? el.dataset.themeMode : 'auto',
    resolved,
    accent: isValidAccent(el.dataset.accent) ? el.dataset.accent : 'blue',
  };
}

/** Keep the mobile browser chrome in sync with the resolved scheme. */
function updateThemeColor(resolved) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[resolved] || THEME_COLOR.light);
}

/** Legacy simple toggle (`#theme-toggle`) — post page until Lead migrates it.
 *  When the button hosts a `[data-morph-icon]` slot the icons module owns the
 *  glyph (morphed on `mosaic:theme`); only the accessible label is updated here
 *  so the CSS fallback icons are never clobbered before hydration. */
function updateLegacyToggle(resolved) {
  const button = document.getElementById('theme-toggle');
  if (!button) return;
  if (!button.querySelector('.morph-icon-slot')) {
    const icon = button.querySelector('i');
    if (icon) icon.className = resolved === 'dark' ? 'ri-moon-line' : 'ri-sun-line';
  }
  const label = resolved === 'dark' ? t('theme_light') : t('theme_dark');
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
}

/** Apply a state and notify listeners (icons morph on `mosaic:theme`). */
function applyState(mode, accent, { persistMode = false, persistAccent = false } = {}) {
  const nextMode = isValidMode(mode) ? mode : 'auto';
  const nextAccent = isValidAccent(accent) ? accent : 'blue';
  const resolved = resolveThemeMode(nextMode);
  const root = rootEl();
  root.dataset.theme = resolved;
  root.dataset.themeMode = nextMode;
  root.dataset.accent = nextAccent;
  if (persistMode) writeStored(THEME_KEY, nextMode);
  if (persistAccent) writeStored(ACCENT_KEY, nextAccent);
  updateThemeColor(resolved);
  updateLegacyToggle(resolved);
  document.dispatchEvent(new CustomEvent('mosaic:theme', { detail: { mode: nextMode, resolved, accent: nextAccent } }));
}

/**
 * Backward-compatible entry: apply a theme preference. Accepts a mode
 * (`auto` | `light` | `dark`) or the old resolved value; `''`/unknown means
 * auto. Does not persist by itself (see `setThemeMode`).
 * @param {string} theme
 */
export function applyTheme(theme) {
  applyState(theme, getThemeState().accent);
}

/** Initial paint + persistence read. Idempotent. */
export function initTheme() {
  const cfg = themeConfig();
  const storedMode = readStored(THEME_KEY);
  const storedAccent = readStored(ACCENT_KEY);
  applyState(
    isValidMode(storedMode) ? storedMode : cfg.defaultMode,
    isValidAccent(storedAccent) ? storedAccent : cfg.accent,
  );

  if (!systemListenerAttached && typeof window.matchMedia === 'function') {
    systemListenerAttached = true;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const state = getThemeState();
      if (state.mode === 'auto') applyState('auto', state.accent);
    };
    if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
    else query.addListener?.(onChange);
  }
}

/** Legacy two-state toggle: cycles the resolved light/dark and persists it. */
export function cycleTheme() {
  const state = getThemeState();
  applyState(state.resolved === 'dark' ? 'light' : 'dark', state.accent, { persistMode: true });
}

/**
 * Set the mode preference and persist it.
 * @param {'auto'|'light'|'dark'} mode
 */
export function setThemeMode(mode) {
  if (!isValidMode(mode)) return;
  applyState(mode, getThemeState().accent, { persistMode: true });
}

/**
 * Set the accent palette and persist it.
 * @param {string} accent
 */
export function setAccent(accent) {
  if (!isValidAccent(accent)) return;
  applyState(getThemeState().mode, accent, { persistAccent: true });
}

/**
 * Wire the header theme menu (disclosure + native radio groups): open/close,
 * click-outside, Escape, focus return, persistence.
 *
 * @param {ParentNode} [root]
 * @returns {() => void} dispose
 */
export function initThemeMenu(root = document) {
  if (typeof document === 'undefined') return () => {};
  const toggle = root.querySelector?.('#theme-menu-toggle');
  const panel = root.querySelector?.('#theme-menu');
  if (!(toggle instanceof HTMLElement) || !(panel instanceof HTMLElement)) return () => {};
  if (toggle.dataset.themeMenuReady === 'true') return () => {};
  if (!themeConfig().allowVisitorToggle) {
    toggle.closest('.theme-menu-root')?.setAttribute('hidden', '');
    return () => {};
  }
  toggle.dataset.themeMenuReady = 'true';

  const modeInputs = Array.from(panel.querySelectorAll('input[name="mosaic-theme-mode"]'));
  const accentInputs = Array.from(panel.querySelectorAll('input[name="mosaic-theme-accent"]'));
  let open = false;
  let closing = false;

  const sync = () => {
    const state = getThemeState();
    modeInputs.forEach((input) => {
      input.checked = input.value === state.mode;
    });
    accentInputs.forEach((input) => {
      input.checked = input.value === state.accent;
    });
  };

  const setOpen = async (next, { focusToggle = false } = {}) => {
    if (next === open) return;
    open = next;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      sync();
      panel.hidden = false;
      animateIn(panel, {
        from: { opacity: 0, y: -6, scale: 0.98 },
        to: { opacity: 1, y: 0, scale: 1 },
        preset: 'snappy',
      });
    } else {
      if (closing) return;
      closing = true;
      await animateOut(panel, { to: { opacity: 0, y: -4, scale: 0.99 }, preset: 'snappy' });
      closing = false;
      if (!open) panel.hidden = true;
      if (focusToggle) toggle.focus();
    }
  };

  const onClickToggle = (event) => {
    event.preventDefault();
    setOpen(!open);
  };
  const onPointerDown = (event) => {
    if (!open) return;
    if (panel.contains(event.target) || toggle.contains(event.target)) return;
    setOpen(false);
  };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    setOpen(false, { focusToggle: true });
  };
  const onFocusOut = (event) => {
    if (!open) return;
    const next = event.relatedTarget;
    if (next && !panel.contains(next) && !toggle.contains(next)) setOpen(false);
  };
  const onChange = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.name === 'mosaic-theme-mode') setThemeMode(input.value);
    else if (input.name === 'mosaic-theme-accent') setAccent(input.value);
  };
  const onTheme = () => sync();

  toggle.addEventListener('click', onClickToggle);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown);
  panel.addEventListener('focusout', onFocusOut);
  panel.addEventListener('change', onChange);
  document.addEventListener('mosaic:theme', onTheme);
  sync();

  return () => {
    toggle.removeEventListener('click', onClickToggle);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
    panel.removeEventListener('focusout', onFocusOut);
    panel.removeEventListener('change', onChange);
    document.removeEventListener('mosaic:theme', onTheme);
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    delete toggle.dataset.themeMenuReady;
  };
}

export { MODES, ACCENTS };
