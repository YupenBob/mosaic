/**
 * Config sections: admin preferences, general site info, author, theme mode
 * (auto/light/dark + accent swatches + visitor toggle, legacy color mode kept
 * for backwards compatibility) and media quality.
 *
 * Sections are pure `(cfg) => html` functions plus a descriptor so the config
 * page shell only needs to concatenate them.
 */
import { t, setLang } from '../i18n.js?v=1';
import { getThemePref, setTheme } from '../theme.js?v=1';
import {
  cfgGet,
  textField,
  textAreaField,
  numberField,
  selectField,
  toggleField,
  segmentedField,
  swatchField,
  callout,
  previewBlock,
  groupHeading,
} from './fields.js?v=1';

/** Accent swatches offered by the frontend theme contract (default: blue). */
export const ACCENTS = [
  { value: 'blue', color: '#4361ee' },
  { value: 'violet', color: '#7c3aed' },
  { value: 'emerald', color: '#059669' },
  { value: 'rose', color: '#e11d48' },
  { value: 'amber', color: '#d97706' },
  { value: 'slate', color: '#64748b' },
];

/** Accent label lookup keyed by contract value. */
export function accentLabel(value) {
  const keys = {
    blue: 'config.accentBlue',
    violet: 'config.accentViolet',
    emerald: 'config.accentEmerald',
    rose: 'config.accentRose',
    amber: 'config.accentAmber',
    slate: 'config.accentSlate',
  };
  return t(keys[value] || keys.blue);
}

/** Theme mode options shared by the segmented control and preview sync. */
export function themeModeOptions() {
  return [
    { value: 'auto', label: t('config.themeAuto') },
    { value: 'light', label: t('config.themeLight') },
    { value: 'dark', label: t('config.themeDark') },
  ];
}

// ── Preferences ────────────────────────────
function prefsSection() {
  const themePref = getThemePref();
  const lang = localStorage.getItem('mosaic_admin_lang') || 'zh-CN';
  return `
    <div class="config-field">
      <label class="config-label"><span>${t('config.adminTheme')}</span><small>${t('config.adminThemeHint')}</small></label>
      <select class="select" id="admin-theme-select" aria-label="${t('config.adminTheme')}" style="width:200px" onchange="window.setAdminTheme(this.value)">
        <option value="auto" ${themePref === 'auto' ? 'selected' : ''}>${t('config.themeAuto')}</option>
        <option value="light" ${themePref === 'light' ? 'selected' : ''}>${t('config.themeLight')}</option>
        <option value="dark" ${themePref === 'dark' ? 'selected' : ''}>${t('config.themeDark')}</option>
      </select>
    </div>
    <div class="config-field">
      <label class="config-label"><span>${t('config.adminLang')}</span><small>${t('config.adminLangHint')}</small></label>
      <select class="select" id="admin-lang-select" aria-label="${t('config.adminLang')}" style="width:200px" onchange="window.setAdminLang(this.value)">
        <option value="zh-CN" ${lang === 'zh-CN' ? 'selected' : ''}>中文简体</option>
        <option value="en" ${lang === 'en' ? 'selected' : ''}>English</option>
      </select>
    </div>
  `;
}

window.setAdminTheme = (pref) => setTheme(pref);
window.setAdminLang = (lang) => setLang(lang);

// ── General ────────────────────────────────
const LOGO_DATA_URI =
  'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 48 48%27%3E%3Crect x=%272%27 y=%272%27 width=%2720%27 height=%2720%27 rx=%275%27 fill=%27%234361ee%27 opacity=%27.9%27/%3E%3Crect x=%2726%27 y=%272%27 width=%2720%27 height=%2720%27 rx=%275%27 fill=%27%234361ee%27 opacity=%27.65%27/%3E%3Crect x=%272%27 y=%2726%27 width=%2720%27 height=%2720%27 rx=%275%27 fill=%27%234361ee%27 opacity=%27.4%27/%3E%3Crect x=%2726%27 y=%2726%27 width=%2720%27 height=%2720%27 rx=%275%27 fill=%27%234361ee%27 opacity=%27.75%27/%3E%3C/svg%3E';

function generalSection(cfg) {
  return `
    <div class="config-field">
      <label class="config-label"><span>${t('config.favicon')}</span><small>${t('config.faviconHint')}</small></label>
      <div class="favicon-row">
        <img id="favicon-preview" src="${cfgGet(cfg, 'favicon') || LOGO_DATA_URI}" class="favicon-img" onerror="this.src='${LOGO_DATA_URI}'" alt="favicon" />
        <input type="file" id="favicon-upload-input" accept=".svg,.png,.ico,image/svg+xml,image/png,image/x-icon" style="display:none" onchange="uploadFavicon(this)" />
        <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('favicon-upload-input').click()"><i class="ri-upload-2-line"></i> ${t('config.faviconUpload')}</button>
      </div>
      <input type="hidden" data-config="favicon" id="favicon-value" value="${esc(cfgGet(cfg, 'favicon'))}" />
    </div>
    ${textField({ key: 'title', label: t('config.siteTitle'), hint: t('config.siteTitleHint'), value: cfgGet(cfg, 'title') })}
    ${textField({ key: 'subtitle', label: t('config.subtitle'), hint: t('config.subtitleHint'), value: cfgGet(cfg, 'subtitle') })}
    ${textAreaField({ key: 'description', label: t('config.desc'), hint: t('config.descHint'), value: cfgGet(cfg, 'description') })}
    ${textField({ key: 'url', label: t('config.url'), hint: t('config.urlHint'), value: cfgGet(cfg, 'url'), type: 'url' })}
    ${textField({ key: 'apiBase', label: t('config.apiBase'), hint: t('config.apiBaseHint'), value: cfgGet(cfg, 'apiBase') })}
    ${textField({ key: 'mediaBase', label: t('config.mediaBase'), hint: t('config.mediaBaseHint'), value: cfgGet(cfg, 'mediaBase') })}
    ${selectField({
      key: 'language',
      label: t('config.lang'),
      hint: t('config.langHint'),
      value: cfgGet(cfg, 'language'),
      options: [
        { value: 'zh-CN', label: '中文简体' },
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
      ],
    })}
    ${textField({ key: 'dateFormat', label: t('config.dateFmt'), hint: t('config.dateFmtHint'), value: cfgGet(cfg, 'dateFormat') })}
  `;
}

/** HTML-escape helper for attribute values inside this module. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Author ─────────────────────────────────
function authorSection(cfg) {
  return `
    ${textField({ key: 'author.name', label: t('config.authorName'), hint: t('config.authorNameHint'), value: cfgGet(cfg, 'author.name') })}
    ${textField({ key: 'author.email', label: t('config.email'), hint: t('config.emailHint'), value: cfgGet(cfg, 'author.email'), type: 'email' })}
  `;
}

// ── Theme mode ─────────────────────────────
/** Mini front-page mock used as a live preview for theme mode + accent. */
export function themePreviewBody() {
  return `
    <div class="theme-preview-card" id="theme-preview-card" data-preview-mode="auto" data-preview-accent="blue" aria-hidden="true">
      <div class="theme-preview-bar"><span class="theme-preview-logo"></span><span class="theme-preview-nav">首页</span><span class="theme-preview-nav">归档</span><span class="theme-preview-toggle"></span></div>
      <div class="theme-preview-hero"><span class="theme-preview-hero-title">Mosaic</span></div>
      <div class="theme-preview-lines"><span></span><span></span><span class="is-short"></span></div>
      <div class="theme-preview-actions"><span class="theme-preview-btn">${t('config.previewRead')}</span><span class="theme-preview-chip">${t('config.previewTag')}</span></div>
    </div>
    <p class="config-preview-caption" id="theme-preview-caption"></p>
  `;
}

function themeSection(cfg) {
  const mode = cfgGet(cfg, 'themeMode.default', cfgGet(cfg, 'theme', 'auto'));
  const accent = cfgGet(cfg, 'themeMode.accent', 'blue');
  return `
    ${callout({
      icon: 'ri-palette-line',
      body: t('config.themeModeIntro'),
    })}
    ${segmentedField({
      key: 'themeMode.default',
      label: t('config.themeDefault'),
      hint: t('config.themeDefaultHint'),
      value: mode,
      options: themeModeOptions(),
    })}
    ${swatchField({
      key: 'themeMode.accent',
      label: t('config.accent'),
      hint: t('config.accentHint'),
      value: accent,
      options: ACCENTS.map((accentOption) => ({ ...accentOption, label: accentLabel(accentOption.value) })),
    })}
    ${toggleField({
      key: 'themeMode.allowVisitorToggle',
      label: t('config.allowVisitorToggle'),
      hint: t('config.allowVisitorToggleHint'),
      checked: cfgGet(cfg, 'themeMode.allowVisitorToggle', true),
    })}
    ${toggleField({
      key: 'themeMode.showMenu',
      label: t('config.showMenu'),
      hint: t('config.showMenuHint'),
      checked: cfgGet(cfg, 'themeMode.showMenu', true),
    })}
    ${previewBlock({ id: 'theme-preview-slot', title: t('config.themePreview'), hint: t('config.themePreviewHint'), body: themePreviewBody() })}
    ${groupHeading(t('config.layoutGroup'))}
    ${selectField({
      key: 'theme',
      label: t('config.themeLegacy'),
      hint: t('config.themeLegacyHint'),
      value: cfgGet(cfg, 'theme', 'auto'),
      options: themeModeOptions(),
    })}
    ${numberField({ key: 'pageSize', label: t('config.pageSize'), hint: t('config.pageSizeHint'), value: cfgGet(cfg, 'pageSize', 10), min: 1, max: 200 })}
    ${numberField({ key: 'gallerySingleThreshold', label: t('config.galleryThresh'), hint: t('config.galleryThreshHint'), value: cfgGet(cfg, 'gallerySingleThreshold', 3), min: 1, max: 50 })}
    ${toggleField({ key: 'cardShowTags', label: t('config.cardTags'), hint: t('config.cardTagsHint'), checked: cfgGet(cfg, 'cardShowTags', true) })}
    ${toggleField({ key: 'cardShowStats', label: t('config.cardStats'), hint: t('config.cardStatsHint'), checked: cfgGet(cfg, 'cardShowStats', true) })}
    ${textAreaField({ key: 'footerText', label: t('config.footer'), hint: t('config.footerHint'), value: cfgGet(cfg, 'footerText') })}
  `;
}

// ── Media quality ──────────────────────────
function mediaQualitySection(cfg) {
  return `
    <div class="config-field">
      <label class="config-label"><span>${t('config.imgQuality')}</span><small>${t('config.imgQualityHint')}</small></label>
      <div class="config-quality-group">
        <label>480p<input type="number" class="input" data-config="imageQuality.480p" data-type="number" aria-label="480p" value="${cfgGet(cfg, 'imageQuality.480p', 75)}" min="1" max="100" /></label>
        <label>720p<input type="number" class="input" data-config="imageQuality.720p" data-type="number" aria-label="720p" value="${cfgGet(cfg, 'imageQuality.720p', 80)}" min="1" max="100" /></label>
        <label>1080p<input type="number" class="input" data-config="imageQuality.1080p" data-type="number" aria-label="1080p" value="${cfgGet(cfg, 'imageQuality.1080p', 85)}" min="1" max="100" /></label>
      </div>
    </div>
    <div class="config-field">
      <label class="config-label"><span>${t('config.videoQuality')}</span><small>${t('config.videoQualityHint')}</small></label>
      <div class="config-quality-group">
        <label>${t('config.crf')}<input type="number" class="input" data-config="videoQuality.crf" data-type="number" aria-label="${t('config.crf')}" value="${cfgGet(cfg, 'videoQuality.crf', 23)}" min="0" max="51" style="width:60px" /></label>
        <label>${t('config.preset')}<select class="select" data-config="videoQuality.preset" aria-label="${t('config.preset')}" style="width:110px">${['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].map((preset) => `<option value="${preset}" ${cfgGet(cfg, 'videoQuality.preset', 'fast') === preset ? 'selected' : ''}>${preset}</option>`).join('')}</select></label>
        <label>${t('config.maxHeight')}<select class="select" data-config="videoQuality.maxHeight" data-type="number" aria-label="${t('config.maxHeight')}" style="width:110px">${[
          [2160, '4K'],
          [1080, '1080p'],
          [720, '720p'],
          [480, '480p'],
          [360, '360p'],
          [240, '240p'],
        ]
          .map(
            ([height, label]) =>
              `<option value="${height}" ${Number(cfgGet(cfg, 'videoQuality.maxHeight', 1080)) === height ? 'selected' : ''}>${label}</option>`,
          )
          .join('')}</select></label>
      </div>
    </div>
  `;
}

/** Section descriptors consumed by the config page shell. */
export const generalSections = [
  { id: 'prefs', icon: 'ri-sliders-line', label: () => t('config.prefs'), body: prefsSection },
  { id: 'general', icon: 'ri-information-line', label: () => t('config.general'), body: generalSection },
  { id: 'author', icon: 'ri-user-line', label: () => t('config.author'), body: authorSection },
  { id: 'theme', icon: 'ri-contrast-2-line', label: () => t('config.themeModeSection'), body: themeSection },
  { id: 'media', icon: 'ri-image-line', label: () => t('config.media'), body: mediaQualitySection },
];
