/**
 * Theme system — auto / light / dark. The inline bootstrap script in
 * index.html applies the resolved theme before first paint; this module
 * provides toggling, persistence and system-following.
 */
const KEY = 'mosaic_admin_theme';

function media() {
  return window.matchMedia('(prefers-color-scheme: dark)');
}

export function getThemePref() {
  try {
    return localStorage.getItem(KEY) || window.__MOSAIC_THEME_PREF__ || 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme() {
  const pref = getThemePref();
  const dark = pref === 'dark' || (pref === 'auto' && media().matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  return { pref, dark };
}

export function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(getThemePref()) + 1) % order.length];
  return setTheme(next);
}

export function setTheme(pref) {
  const order = ['auto', 'light', 'dark'];
  if (!order.includes(pref)) pref = 'auto';
  try {
    localStorage.setItem(KEY, pref);
  } catch {}
  applyTheme();
  updateThemeButton();
  return pref;
}

export function updateThemeButton() {
  const btn = document.getElementById('topbar-theme-btn');
  if (!btn) return;
  const pref = getThemePref();
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  let icon = 'ri-sun-line', label = 'Auto';
  if (pref === 'dark') icon = 'ri-moon-line';
  else if (pref === 'light') icon = 'ri-sun-line';
  else icon = dark ? 'ri-moon-clear-line' : 'ri-sun-line';
  btn.innerHTML = `<i class="${icon}"></i>`;
  btn.title = `Theme: ${pref}`;
  btn.setAttribute('aria-label', `Theme: ${pref}`);
}

export function initTheme() {
  media().addEventListener('change', () => {
    if (getThemePref() === 'auto') {
      applyTheme();
      updateThemeButton();
    }
  });
  updateThemeButton();
}
