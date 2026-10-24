/**
 * App-level pollers and build/dirty chrome.
 *
 * Owns the dirty banner, the one-shot build status poller, the site URL in
 * the topbar and the global build trigger. Extracted from admin.js so the
 * entry point stays limited to auth, routing shell and i18n wiring.
 */
import { getToken, build, config as configApi } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=1';
import { toast, formatTime } from './ui.js?v=1';

let dirtyPollTimer = null;
let buildPollTimer = null;
let buildRunning = false;
let currentBuildRun = null;

/** Whether a site build is currently queued/running. */
export function isBuildRunning() {
  return buildRunning;
}

// ── Dirty banner ───────────────────────────
export function showDirtyBanner(count, last) {
  const banner = document.getElementById('dirty-banner');
  if (!banner) return;
  banner.classList.remove('is-building');
  const spinner = document.getElementById('dirty-banner-spinner');
  if (spinner) spinner.hidden = true;
  const ago = last ? t('dirty.ago', { time: formatTime(last) }) : '';
  const text = document.getElementById('dirty-banner-text');
  if (text) text.textContent = t('dirty.text', { count, ago });
  banner.style.display = 'flex';
  const badge = document.getElementById('nav-build-badge');
  if (badge) {
    badge.textContent = count;
    badge.style.display = '';
  }
}

export function hideDirtyBanner() {
  const banner = document.getElementById('dirty-banner');
  if (banner) {
    banner.style.display = 'none';
    banner.classList.remove('is-building');
    const spinner = document.getElementById('dirty-banner-spinner');
    if (spinner) spinner.hidden = true;
  }
  const badge = document.getElementById('nav-build-badge');
  if (badge) badge.style.display = 'none';
}

function showBuildingBanner(run) {
  const banner = document.getElementById('dirty-banner');
  if (!banner) return;
  banner.classList.add('is-building');
  const spinner = document.getElementById('dirty-banner-spinner');
  if (spinner) spinner.hidden = false;
  const runLabel = run && run.runNumber ? ' #' + run.runNumber : '';
  const text = document.getElementById('dirty-banner-text');
  if (text) text.textContent = t('dirty.building') + runLabel;
  banner.style.display = 'flex';
  const badge = document.getElementById('nav-build-badge');
  if (badge) badge.style.display = 'none';
}

/** Refresh the dirty banner from `/api/dirty` (also used by save handlers). */
export async function checkDirty() {
  const token = getToken();
  if (!token || state.authStatus !== 'ok') return;
  const API = window.__API_BASE__ || '/api';
  try {
    const resp = await fetch(API + '/dirty', { headers: { Authorization: 'Bearer ' + token } });
    if (!resp.ok) return;
    const dirty = await resp.json();
    if (buildRunning) {
      showBuildingBanner(currentBuildRun);
      return;
    }
    if (dirty.count > 0) showDirtyBanner(dirty.count, dirty.last);
    else hideDirtyBanner();
  } catch {
    /* keep the previous banner on transient failures */
  }
}

// ── Pollers ────────────────────────────────
export function startPollers() {
  stopPollers();
  checkDirty();
  pollBuildStatus();
  loadSiteUrl();
  dirtyPollTimer = setInterval(checkDirty, state.config.admin?.dirtyPollMs || 60000);
}

async function loadSiteUrl() {
  if (state.config.url) state.siteUrl = state.config.url;
  if (state.siteUrl) {
    const btn = document.getElementById('topbar-site-btn');
    if (btn) btn.href = state.siteUrl;
    return;
  }
  try {
    const cfg = await configApi.get({ signal: null });
    if (cfg.url) {
      state.siteUrl = cfg.url;
      state.mediaBase = cfg.mediaBase || state.mediaBase;
      const btn = document.getElementById('topbar-site-btn');
      if (btn) btn.href = cfg.url;
    }
  } catch {
    /* topbar link stays hidden on failure */
  }
}

export function stopPollers() {
  if (dirtyPollTimer) {
    clearInterval(dirtyPollTimer);
    dirtyPollTimer = null;
  }
  if (buildPollTimer) {
    clearInterval(buildPollTimer);
    buildPollTimer = null;
  }
}

async function pollBuildStatus() {
  const dot = document.getElementById('topbar-build-dot');
  if (!dot) return;
  try {
    const status = await build.status({ signal: null }).catch(() => null);
    const running = !!(status && (status.status === 'in_progress' || status.status === 'queued'));
    buildRunning = running;
    currentBuildRun = running ? status : null;
    if (running) showBuildingBanner(status);
    else checkDirty();
    if (!status || !status.status || status.status === 'unknown') {
      dot.className = 'status-dot';
      dot.title = '';
      window.setBuildTriggerStates && window.setBuildTriggerStates(false);
      return;
    }
    if (status.status === 'in_progress' || status.status === 'queued') {
      dot.className = 'status-dot busy';
      dot.title = t('build.running') + ' #' + (status.runNumber || '');
      window.setBuildTriggerStates && window.setBuildTriggerStates(true);
    } else if (status.conclusion === 'success') {
      dot.className = 'status-dot ok';
      dot.title = t('build.success');
      window.setBuildTriggerStates && window.setBuildTriggerStates(false);
    } else if (status.conclusion === 'failure') {
      dot.className = 'status-dot down';
      dot.title = t('build.failed');
      window.setBuildTriggerStates && window.setBuildTriggerStates(false);
    } else {
      dot.className = 'status-dot';
      dot.title = '';
      window.setBuildTriggerStates && window.setBuildTriggerStates(false);
    }
  } catch {
    /* transient */
  } finally {
    if (getToken() && state.authStatus === 'ok') {
      clearTimeout(buildPollTimer);
      buildPollTimer = setTimeout(
        pollBuildStatus,
        document.hidden
          ? state.config.admin?.hiddenPollMs || 60000
          : buildRunning
            ? state.config.admin?.jobPollMs || 5000
            : state.config.admin?.idlePollMs || 30000,
      );
    }
  }
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
  const topbarBtn = document.getElementById('topbar-build-btn');
  if (topbarBtn) {
    if (running) {
      if (topbarBtn.dataset.restore === undefined) topbarBtn.dataset.restore = topbarBtn.innerHTML;
      topbarBtn.disabled = true;
      topbarBtn.innerHTML = '<span class="btn-spinner"></span>';
    } else {
      topbarBtn.disabled = false;
      if (topbarBtn.dataset.restore !== undefined) {
        topbarBtn.innerHTML = topbarBtn.dataset.restore;
        delete topbarBtn.dataset.restore;
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
  const topbarBtn = document.getElementById('topbar-build-btn');
  if (topbarBtn) {
    if (topbarBtn.dataset.restore === undefined) topbarBtn.dataset.restore = topbarBtn.innerHTML;
    topbarBtn.disabled = true;
    topbarBtn.innerHTML = '<span class="btn-spinner"></span>';
  }
  try {
    const result = await build.trigger();
    hideDirtyBanner();
    toast(t('build.triggered', { method: result.method || 'push' }), 'success', 5000);
    if (result.wfError) toast(t('build.fallbackUsed', { error: result.wfError }), 'info', 6000);
    window.setBuildTriggerStates(true);
    if (location.hash !== '#build') location.hash = 'build';
    pollBuildStatus();
  } catch (error) {
    const message = error.message || '';
    if (message.includes('already in progress') || message.includes('BUILD_RUNNING')) {
      toast(t('build.alreadyRunning'), 'info', 5000);
      window.setBuildTriggerStates(true);
      if (location.hash !== '#build') location.hash = 'build';
    } else {
      toast(t('build.triggerFailed') + ': ' + message, 'error', 8000, {
        label: t('common.retry'),
        onClick: () => window.doTriggerBuild(),
      });
      window.setBuildTriggerStates(false);
    }
  }
};

// Exposed for the inline dirty-banner CTA and page modules.
window.checkDirty = checkDirty;
