/**
 * Frontend theme: light / dark, persisted in localStorage and applied before
 * first paint (see the inline script in each layout's <head>).
 *
 * The toggle cycles dark <-> light. No stored preference = follow the system
 * (prefers-color-scheme), matching the CSS fallback in tokens.css.
 */
import { t } from './data.js';

const KEY = 'mosaic_theme';

function systemDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(theme) {
  return theme === 'light' || theme === 'dark' ? theme : systemDark() ? 'dark' : 'light';
}

export function applyTheme(theme) {
  const resolved = resolve(theme);
  document.documentElement.setAttribute('data-theme', resolved);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    const icon = btn.querySelector('i');
    if (icon) icon.className = resolved === 'dark' ? 'ri-moon-line' : 'ri-sun-line';
    const label = resolved === 'dark' ? t('theme_light') : t('theme_dark');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }
}

export function cycleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(KEY, next);
  } catch {}
  applyTheme(next);
}

export function initTheme() {
  let saved = '';
  try {
    saved = localStorage.getItem(KEY) || '';
  } catch {}
  applyTheme(saved);
}
