/**
 * Site Configuration — anchored sections, live search, global preferences,
 * dirty tracking with save/discard, favicon upload.
 */
import { config, getToken } from '../src/api.js';
import { t, setLang } from './i18n.js';
import { setTheme, getThemePref } from './theme.js';
import { state } from './state.js';
import { escHtml, toast } from './ui.js';

const LOGO_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Crect x='2' y='2' width='20' height='20' rx='5' fill='%234361ee' opacity='.9'/%3E%3Crect x='26' y='2' width='20' height='20' rx='5' fill='%234361ee' opacity='.65'/%3E%3Crect x='2' y='26' width='20' height='20' rx='5' fill='%234361ee' opacity='.4'/%3E%3Crect x='26' y='26' width='20' height='20' rx='5' fill='%234361ee' opacity='.75'/%3E%3C/svg%3E";

export default async function renderConfig(signal) {
  let cfg = {};
  try {
    cfg = await config.get();
  } catch {}
  if (signal.aborted) return '';
  state.config = cfg;

  const sections = [
    ['prefs', 'ri-sliders-line', t('config.prefs'), prefsSection()],
    ['general', 'ri-information-line', t('config.general'), generalSection(cfg)],
    ['author', 'ri-user-line', t('config.author'), authorSection(cfg)],
    ['theme', 'ri-palette-line', t('config.theme'), themeSection(cfg)],
    ['media', 'ri-image-line', t('config.media'), mediaSection(cfg)],
    ['features', 'ri-toggle-line', t('config.features'), featuresSection(cfg)],
    ['giscus', 'ri-chat-3-line', t('config.giscus'), giscusSection(cfg)],
    ['plugins', 'ri-puzzle-line', t('config.plugins'), pluginsSection(cfg)],
  ];

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

        <div class="config-search-wrap">
          <i class="ri-search-line"></i>
          <input type="text" id="config-search" class="input" placeholder="${t('config.search')}" oninput="filterConfig(this.value)" aria-label="${t('config.search')}" />
        </div>

        <div class="config-layout">
          <nav class="config-rail" aria-label="Sections">
            ${sections.map(([id, icon, label]) => `<a href="#config-${id}" data-target="${id}"><i class="${icon}"></i> ${escHtml(label)}</a>`).join('')}
          </nav>
          <div class="config-grid">
            ${sections
              .map(
                ([id, icon, label, body]) => `
              <section class="config-section" id="config-section-${id}" data-section="${id}">
                <h3 class="config-section-title"><i class="${icon}"></i> ${escHtml(label)}</h3>
                <div class="config-fields">${body}</div>
              </section>`,
              )
              .join('')}
          </div>
        </div>
      </div>
    `,
    onMount() {
      // Scrollspy + click-to-scroll on the rail
      const links = document.querySelectorAll('.config-rail a');
      const sectionsEls = document.querySelectorAll('.config-section');
      const spy = () => {
        let current = sectionsEls[0]?.dataset.section;
        for (const s of sectionsEls) {
          if (s.getBoundingClientRect().top <= 100) current = s.dataset.section;
        }
        links.forEach((a) => a.classList.toggle('active', a.dataset.target === current));
      };
      document.addEventListener('scroll', spy, { passive: true });
      links.forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const el = document.getElementById('config-section-' + a.dataset.target);
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
      spy();
      wireConfigDirty();
    },
  };
}

function wireConfigDirty() {
  document.querySelectorAll('[data-config]').forEach((el) => {
    ['input', 'change'].forEach((evt) =>
      el.addEventListener(evt, () => {
        const hint = document.getElementById('config-dirty-hint');
        const discard = document.getElementById('config-discard-btn');
        if (hint) hint.style.display = 'block';
        if (discard) discard.style.display = '';
      }),
    );
  });
}

window.filterConfig = (q) => {
  q = q.toLowerCase().trim();
  document.querySelectorAll('.config-field').forEach((f) => {
    const text = (f.textContent || '').toLowerCase();
    f.style.display = !q || text.includes(q) ? '' : 'none';
  });
  document.querySelectorAll('.config-section').forEach((s) => {
    const visible = [...s.querySelectorAll('.config-field')].some((f) => f.style.display !== 'none');
    s.style.display = !q || visible ? '' : 'none';
  });
};

window.discardConfig = () => {
  location.hash = 'config&_r=' + Date.now();
};

window.doSaveConfig = async () => {
  const data = {};
  document.querySelectorAll('[data-config]').forEach((el) => {
    const keys = el.dataset.config.split('.');
    const type = el.dataset.type || (el.type === 'number' ? 'number' : 'text');
    let val;
    if (type === 'bool') val = el.checked;
    else if (type === 'number') val = parseInt(el.value) || 0;
    else val = el.value;
    let obj = data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = val;
  });
  const btn = document.querySelector('.page-header .btn-primary');
  btn.disabled = true;
  try {
    await config.update(data);
    const hint = document.getElementById('config-dirty-hint');
    const discard = document.getElementById('config-discard-btn');
    if (hint) hint.style.display = 'none';
    if (discard) discard.style.display = 'none';
    window.checkDirty && window.checkDirty();
    toast(t('config.saved'), 'success');
  } catch (err) {
    toast(t('config.saveFailed') + ': ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
};

// ── Field helpers ──────────────────────────
function cfgGet(obj, path, def = '') {
  return path.split('.').reduce((o, k) => (o || {})[k], obj) ?? def;
}
function txt(key, label, hint, cfg, type = 'text') {
  return `<div class="config-field"><label class="config-label"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label><input type="${type}" class="input" data-config="${key}" value="${escHtml(String(cfgGet(cfg, key)))}" /></div>`;
}
function area(key, label, hint, cfg) {
  return `<div class="config-field"><label class="config-label"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label><textarea class="textarea" data-config="${key}" rows="2">${escHtml(String(cfgGet(cfg, key)))}</textarea></div>`;
}
function num(key, label, hint, cfg) {
  return `<div class="config-field"><label class="config-label"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label><input type="number" class="input" data-config="${key}" data-type="number" value="${cfgGet(cfg, key, 0)}" /></div>`;
}
function sel(key, label, hint, cfg, options) {
  const val = cfgGet(cfg, key);
  return `<div class="config-field"><label class="config-label"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label><select class="select" data-config="${key}">${options.map((o) => `<option value="${o[0]}" ${val === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div>`;
}
function tog(key, label, hint, cfg) {
  const val = cfgGet(cfg, key, false);
  return `<div class="config-field"><label class="config-label"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label><label class="toggle-switch"><input type="checkbox" data-config="${key}" data-type="bool" ${val ? 'checked' : ''} /><span class="toggle-slider"></span></label></div>`;
}

// ── Sections ───────────────────────────────
function prefsSection() {
  const themePref = getThemePref();
  const lang = localStorage.getItem('mosaic_admin_lang') || 'zh-CN';
  return `
    <div class="config-field">
      <label class="config-label"><span>${t('config.adminTheme')}</span><small>${t('config.adminThemeHint')}</small></label>
      <select class="select" id="admin-theme-select" style="width:200px" onchange="window.setAdminTheme(this.value)">
        <option value="auto" ${themePref === 'auto' ? 'selected' : ''}>${t('config.themeAuto')}</option>
        <option value="light" ${themePref === 'light' ? 'selected' : ''}>${t('config.themeLight')}</option>
        <option value="dark" ${themePref === 'dark' ? 'selected' : ''}>${t('config.themeDark')}</option>
      </select>
    </div>
    <div class="config-field">
      <label class="config-label"><span>${t('config.adminLang')}</span><small>${t('config.adminLangHint')}</small></label>
      <select class="select" id="admin-lang-select" style="width:200px" onchange="window.setAdminLang(this.value)">
        <option value="zh-CN" ${lang === 'zh-CN' ? 'selected' : ''}>中文简体</option>
        <option value="en" ${lang === 'en' ? 'selected' : ''}>English</option>
      </select>
    </div>
  `;
}

window.setAdminTheme = (pref) => {
  setTheme(pref);
};
window.setAdminLang = (lang) => setLang(lang);

function generalSection(cfg) {
  return `
    <div class="config-field">
      <label class="config-label"><span>${t('config.favicon')}</span><small>${t('config.faviconHint')}</small></label>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
        <img id="favicon-preview" src="${escHtml(cfgGet(cfg, 'favicon') || LOGO_DATA_URI)}" style="width:32px;height:32px;border-radius:6px;border:1px solid var(--color-border);object-fit:contain" onerror="this.src='${LOGO_DATA_URI}'" alt="favicon" />
        <input type="file" id="favicon-upload-input" accept=".svg,.png,.ico,image/svg+xml,image/png,image/x-icon" style="display:none" onchange="uploadFavicon(this)" />
        <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('favicon-upload-input').click()"><i class="ri-upload-2-line"></i> ${t('config.faviconUpload')}</button>
      </div>
      <input type="hidden" data-config="favicon" id="favicon-value" value="${escHtml(cfgGet(cfg, 'favicon'))}" />
    </div>
    ${txt('title', t('config.siteTitle'), t('config.siteTitleHint'), cfg)}
    ${txt('subtitle', t('config.subtitle'), t('config.subtitleHint'), cfg)}
    ${area('description', t('config.desc'), t('config.descHint'), cfg)}
    ${txt('url', t('config.url'), t('config.urlHint'), cfg, 'url')}
    ${txt('apiBase', t('config.apiBase'), t('config.apiBaseHint'), cfg, 'url')}
    ${txt('mediaBase', t('config.mediaBase'), t('config.mediaBaseHint'), cfg, 'url')}
    ${sel('language', t('config.lang'), t('config.langHint'), cfg, [
      ['zh-CN', '中文简体'],
      ['en', 'English'],
      ['ja', '日本語'],
    ])}
    ${txt('dateFormat', t('config.dateFmt'), t('config.dateFmtHint'), cfg)}
  `;
}

function authorSection(cfg) {
  return `
    ${txt('author.name', t('config.authorName'), t('config.authorNameHint'), cfg)}
    ${txt('author.email', t('config.email'), t('config.emailHint'), cfg, 'email')}
  `;
}

function themeSection(cfg) {
  return `
    ${sel('theme', t('config.theme'), t('config.themeHint'), cfg, [
      ['auto', t('config.themeAuto')],
      ['light', t('config.themeLight')],
      ['dark', t('config.themeDark')],
    ])}
    ${num('pageSize', t('config.pageSize'), t('config.pageSizeHint'), cfg)}
    ${num('gallerySingleThreshold', t('config.galleryThresh'), t('config.galleryThreshHint'), cfg)}
    ${tog('cardShowTags', t('config.cardTags'), t('config.cardTagsHint'), cfg)}
    ${tog('cardShowStats', t('config.cardStats'), t('config.cardStatsHint'), cfg)}
    ${area('footerText', t('config.footer'), t('config.footerHint'), cfg)}
  `;
}

function mediaSection(cfg) {
  return `
    <div class="config-field">
      <label class="config-label"><span>${t('config.imgQuality')}</span><small>${t('config.imgQualityHint')}</small></label>
      <div class="config-quality-group">
        <label>480p<input type="number" class="input" data-config="imageQuality.480p" value="${cfgGet(cfg, 'imageQuality.480p', 75)}" min="1" max="100" /></label>
        <label>720p<input type="number" class="input" data-config="imageQuality.720p" value="${cfgGet(cfg, 'imageQuality.720p', 80)}" min="1" max="100" /></label>
        <label>1080p<input type="number" class="input" data-config="imageQuality.1080p" value="${cfgGet(cfg, 'imageQuality.1080p', 85)}" min="1" max="100" /></label>
      </div>
    </div>
    <div class="config-field">
      <label class="config-label"><span>${t('config.videoQuality')}</span><small>${t('config.videoQualityHint')}</small></label>
      <div class="config-quality-group">
        <label>${t('config.crf')}<input type="number" class="input" data-config="videoQuality.crf" value="${cfgGet(cfg, 'videoQuality.crf', 23)}" min="0" max="51" style="width:60px" /></label>
        <select class="select" data-config="videoQuality.preset" style="width:110px">${['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].map((p) => `<option value="${p}" ${cfgGet(cfg, 'videoQuality.preset', 'fast') === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
        <label>${t('config.maxHeight')}<select class="select" data-config="videoQuality.maxHeight" data-type="number" style="width:110px">${[
          [2160, '4K'],
          [1080, '1080p'],
          [720, '720p'],
          [480, '480p'],
          [360, '360p'],
          [240, '240p'],
        ]
          .map(
            ([v, l]) =>
              `<option value="${v}" ${Number(cfgGet(cfg, 'videoQuality.maxHeight', 1080)) === v ? 'selected' : ''}>${l}</option>`,
          )
          .join('')}</select></label>
      </div>
    </div>
  `;
}

function featuresSection(cfg) {
  return `
    ${tog('enableBusuanzi', t('config.busuanzi'), t('config.busuanziHint'), cfg)}
    ${tog('enableVideoCompression', t('config.videoCompress'), t('config.videoCompressHint'), cfg)}
    ${num('searchMinChars', t('config.searchMin'), t('config.searchMinHint'), cfg)}
    <div class="config-field" style="border-bottom:none;padding-top:14px"><label class="config-label"><span style="font-weight:600">${t('config.compSwitch')}</span><small>${t('config.compSwitchHint')}</small></label></div>
    ${tog('components.gallery.enabled', t('config.gallery'), t('config.galleryHint'), cfg)}
    ${tog('components.video.enabled', t('config.video'), t('config.videoHint'), cfg)}
    ${tog('components.comments.enabled', t('config.comments'), t('config.commentsHint'), cfg)}
    ${tog('components.search.enabled', t('config.searchToggle'), t('config.searchToggleHint'), cfg)}
    ${tog('components.likes.enabled', t('config.likes'), t('config.likesHint'), cfg)}
    ${tog('components.stats.enabled', t('config.stats'), t('config.statsHint'), cfg)}
  `;
}

function giscusSection(cfg) {
  return `
    <p class="muted" style="margin-bottom:12px">${t('config.giscusHint')} <a href="https://giscus.app" target="_blank" rel="noopener" style="color:var(--color-accent)">giscus.app</a></p>
    ${txt('giscus.repo', t('config.giscusRepo'), t('config.giscusRepoHint'), cfg)}
    ${txt('giscus.repoId', t('config.giscusRepoId'), t('config.giscusRepoIdHint'), cfg)}
    ${txt('giscus.category', t('config.giscusCat'), t('config.giscusCatHint'), cfg)}
    ${txt('giscus.categoryId', t('config.giscusCatId'), t('config.giscusCatIdHint'), cfg)}
  `;
}

function pluginsSection(cfg) {
  return `
    ${tog('plugins.compress-images.enabled', t('config.imgCompress'), t('config.imgCompressHint'), cfg)}
    ${tog('plugins.compress-videos.enabled', t('config.videoCompressPlugin'), t('config.videoCompressPluginHint'), cfg)}
    ${tog('plugins.generate-feed.enabled', t('config.rss'), t('config.rssHint'), cfg)}
    ${tog('plugins.generate-sitemap.enabled', t('config.sitemap'), t('config.sitemapHint'), cfg)}
  `;
}

window.uploadFavicon = async (input) => {
  const file = input.files[0];
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
    });
    if (!resp.ok) throw new Error('Upload failed');
    const mediaBase = state.mediaBase || window.__MEDIA_BASE__ || '';
    const url = mediaBase ? `${mediaBase}/site-data/favicon.${ext}` : `/api/media/file/site-data/favicon.${ext}`;
    document.getElementById('favicon-preview').src = url;
    document.getElementById('favicon-preview').style.display = '';
    document.getElementById('favicon-value').value = url;
    toast(t('config.faviconUploaded'), 'success');
  } catch (e) {
    toast(t('config.faviconFailed') + ': ' + e.message, 'error');
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
