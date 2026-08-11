/**
 * Stats tracking - Busuanzi integration + dwell time.
 * Dwell time capped at 2 hours per session to avoid runaway numbers.
 */
import { $ } from './utils.js';

const DWELL_STORAGE_KEY = 'mosaic_dwell';
const SAVE_INTERVAL = 30000;
const MAX_SESSION = 7200; // 2 hours max per session

export function initStats({ apiBase = '/api' } = {}) {
  const slug = document.body.dataset.slug;
  if (!slug) return;

  // Clean up old runaway values from earlier buggy versions
  cleanOldData(slug);

  trackDwellTime(slug, apiBase);
  updateDisplayedStats(slug);
}

function cleanOldData(slug) {
  const dwell = loadDwellTime(slug);
  if (dwell > 86400) {
    // Over 24 hours is clearly a bug from old accumulative logic
    saveDwellTime(slug, 0);
  }
}

function reportDwell(slug, seconds, apiBase) {
  try {
    if (!navigator.sendBeacon || seconds <= 0) return;
    const url = `${apiBase}/track/dwell/${encodeURIComponent(slug)}`;
    const blob = new Blob([JSON.stringify({ seconds })], { type: 'application/json' });
    navigator.sendBeacon(url, blob);
  } catch {
    /* ignore */
  }
}

function trackDwellTime(slug, apiBase) {
  let visibleMs = 0;
  let lastVisibleAt = Date.now();
  let reported = false;

  // Only count dwell while the tab is visible: a backgrounded tab would
  // otherwise inflate the per-session time and pollute the stats.
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      lastVisibleAt = Date.now();
    } else {
      visibleMs += Date.now() - lastVisibleAt;
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const elapsedSec = () => {
    const current = visibleMs + (document.visibilityState === 'visible' ? Date.now() - lastVisibleAt : 0);
    return Math.min(Math.floor(current / 1000), MAX_SESSION);
  };

  const interval = setInterval(() => {
    saveDwellTime(slug, elapsedSec());
    reportDwell(slug, elapsedSec(), apiBase);
  }, SAVE_INTERVAL);

  // pagehide is the reliable hook on mobile Safari; beforeunload is a fallback.
  const reportOnce = () => {
    if (reported) return;
    reported = true;
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisibility);
    saveDwellTime(slug, elapsedSec());
    reportDwell(slug, elapsedSec(), apiBase);
  };
  window.addEventListener('pagehide', reportOnce);
  window.addEventListener('beforeunload', reportOnce);
}

function loadDwellTime(slug) {
  try {
    const raw = localStorage.getItem(DWELL_STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return data[slug] || 0;
  } catch {
    return 0;
  }
}

function saveDwellTime(slug, seconds) {
  try {
    const raw = localStorage.getItem(DWELL_STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : {};
    data[slug] = Math.min(seconds, MAX_SESSION);
    localStorage.setItem(DWELL_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage unavailable
  }
}

function updateDisplayedStats(slug) {
  const dwell = loadDwellTime(slug);
  const dwellEl = $('#dwell-time-display');
  if (dwellEl && dwell > 0) {
    dwellEl.textContent = fmtDuration(dwell);
  }
}

function fmtDuration(sec) {
  if (!sec || sec <= 0 || !isFinite(sec)) return '0s';
  if (sec < 60) return sec + 's';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm ' + s + 's';
}
