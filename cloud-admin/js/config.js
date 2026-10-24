/**
 * Site Configuration page shell.
 *
 * Renders the anchored section rail, search box, dirty banner and save /
 * discard actions; section markup comes from `config/sections-*.js` and the
 * form mechanics from `config/form.js`. New modules are statically imported
 * so the published admin bundle (scripts/stage-admin.mjs) includes them.
 */
import { config as configApi, getToken } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=1';
import { escHtml, toast } from './ui.js?v=1';
import { generalSections } from './config/sections-general.js?v=1';
import { experienceSections } from './config/sections-experience.js?v=1';
import { extraSections } from './config/sections-extras.js?v=1';
import { wireConfigDirty, setupConfigScrollSpy } from './config/form.js?v=1';
import { mountConfigLive } from './config/live.js?v=1';

/** All config sections in display order. */
function allSections() {
  return [...generalSections, ...experienceSections, ...extraSections];
}

/** Render a load-error banner with an inline retry instead of a blank page. */
function loadErrorBanner() {
  return `<div class="config-load-error" role="alert">
    <i class="ri-error-warning-line" aria-hidden="true"></i>
    <span>${t('config.loadFailed')}</span>
    <button type="button" class="btn btn-secondary btn-sm" onclick="location.hash='config&_r=' + Date.now()"><i class="ri-refresh-line"></i> ${t('common.retry')}</button>
  </div>`;
}

export default async function renderConfig(signal) {
  let cfg = {};
  let loadFailed = false;
  try {
    cfg = await configApi.get();
  } catch {
    loadFailed = true;
    // Keep the last known values (e.g. from login bootstrap) so an expired
    // request never blanks the form the user is about to edit.
    cfg = state.config || {};
  }
  if (signal.aborted) return '';
  state.config = cfg;

  const sections = allSections();

  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>${t('config.title')}</h1>
            <p class="page-subtitle" id="config-dirty-hint" style="display:none;color:var(--color-warning)"><i class="ri-circle-fill" style="font-size:8px"></i> ${t('config.unsaved')}</p>
          </div>
          <div class="page-header-actions">
            <button class="btn btn-secondary" id="config-discard-btn" style="display:none" onclick="discardConfig()"><i class="ri-close-line"></i> ${t('config.discard')}</button>
            <button class="btn btn-primary" onclick="doSaveConfig()"><i class="ri-save-line"></i> ${t('config.save')}</button>
          </div>
        </div>

        ${loadFailed ? loadErrorBanner() : ''}

        <div class="config-search-wrap">
          <i class="ri-search-line" aria-hidden="true"></i>
          <input type="text" id="config-search" class="input" placeholder="${t('config.search')}" oninput="filterConfig(this.value)" aria-label="${t('config.search')}" />
        </div>
        <p class="config-no-match" id="config-no-match" hidden><i class="ri-search-line"></i> ${t('config.noMatch')}</p>

        <div class="config-layout">
          <nav class="config-rail" aria-label="${t('config.sectionsAria')}">
            ${sections.map((section) => `<a href="#config-${section.id}" data-target="${section.id}"><i class="${section.icon}" aria-hidden="true"></i> ${escHtml(section.label())}</a>`).join('')}
          </nav>
          <div class="config-grid">
            ${sections
              .map(
                (section) => `
              <section class="config-section" id="config-section-${section.id}" data-section="${section.id}">
                <h2 class="config-section-title"><i class="${section.icon}" aria-hidden="true"></i> ${escHtml(section.label())}</h2>
                <div class="config-fields">${section.body(cfg)}</div>
              </section>`,
              )
              .join('')}
          </div>
        </div>
      </div>
    `,
    onMount() {
      const root = document.getElementById('main-content') || document;
      setupConfigScrollSpy(signal);
      wireConfigDirty(signal);
      mountConfigLive(root, signal);
    },
  };
}

// ── Favicon upload ─────────────────────────
window.uploadFavicon = async (input) => {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 102400) {
    toast(t('config.faviconTooBig'), 'error');
    return;
  }
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!['svg', 'png', 'ico'].includes(ext)) {
    toast(t('config.faviconType'), 'error');
    return;
  }
  const token = getToken();
  const API = window.__API_BASE__ || '/api';
  try {
    const resp = await fetch(`${API}/upload/direct/site-data/favicon.${ext}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': file.type || 'image/svg+xml' },
      body: file,
      signal: state.pageScope?.signal,
    });
    if (!resp.ok) throw new Error('Upload failed');
    const mediaBase = state.mediaBase || window.__MEDIA_BASE__ || '';
    const url = mediaBase ? `${mediaBase}/site-data/favicon.${ext}` : `/api/media/file/site-data/favicon.${ext}`;
    const preview = document.getElementById('favicon-preview');
    if (preview) {
      preview.src = url;
      preview.style.display = '';
    }
    const value = document.getElementById('favicon-value');
    if (value) value.value = url;
    toast(t('config.faviconUploaded'), 'success');
  } catch (error) {
    if (error.name === 'AbortError') return;
    toast(t('config.faviconFailed') + ': ' + error.message, 'error', 7000, {
      label: t('common.retry'),
      onClick: () => window.uploadFavicon(input),
    });
  }
};

export const configSkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:150px;height:30px"></div></div>
    <div class="skeleton skeleton-line" style="width:320px;height:34px;margin-bottom:16px;border-radius:8px"></div>
    <div class="config-grid">
      ${[1, 2, 3].map(() => '<div class="skeleton-card"><div class="skeleton skeleton-line w40" style="height:18px;margin-bottom:12px"></div>' + [1, 2, 3, 4].map(() => '<div class="skeleton skeleton-line"></div>').join('') + '</div>').join('')}
    </div>
  </div>
`;
