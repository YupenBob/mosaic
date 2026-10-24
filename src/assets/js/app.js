/**
 * Mosaic App — thin orchestrator. Page chrome (theme, motion, icons) starts
 * immediately; content components and experience layers initialize lazily so
 * one failing enhancement can never take down the page.
 *
 * Experience layers are optional and self-disable from
 * `window.__MOSAIC_CONFIG.experience.*` (absent key = enabled):
 *  - note modal (list pages): click a card to read it without navigating
 *  - vertical feed (list pages): Douyin-style full-screen video browsing
 *  - motion / Morphicons / theme menu: page chrome
 */
import { $ } from './utils.js';
import { setPosts, initI18n } from './data.js';
import { register, loadComponents } from './components.js';
import { initTheme, cycleTheme, initThemeMenu } from './theme.js';
import { initMotion } from './motion/index.js';
import { initCardMedia } from './cards/media.js';
import { initMasonry } from './cards/masonry.js';
import { initNoteModal } from './note/index.js';
import { initVerticalFeed } from './feed/index.js';
import { initFilter } from './filter.js';
import { initSearch } from './search.js';

const DATA_BASE = document.querySelector('meta[name="data-base"]')?.content || '/data';
const PAGE_TYPE = document.body.dataset.page || 'list';
const disposers = [];

/** Run one enhancement; failures are logged, never fatal. */
function safe(name, init) {
  try {
    const dispose = init();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  } catch (error) {
    console.error(`[app] ${name} init failed:`, error);
    return null;
  }
}

// Init i18n from injected globals
if (window.__I18N && window.__LANG) initI18n(window.__I18N, window.__LANG);

// Register components
register({
  name: 'gallery',
  enabled: true,
  page: 'post',
  async init() {
    if ($('.gallery-grid, .gallery-single')) {
      const { initGallery } = await import('./gallery.js');
      initGallery(window.__MOSAIC_CONFIG?.components?.gallery || {});
    }
  },
});

register({
  name: 'video',
  enabled: true,
  page: 'post',
  async init() {
    if (document.querySelectorAll('.video-container').length > 0) {
      const { initVideoPlayers } = await import('./video.js');
      initVideoPlayers();
    }
  },
});

register({
  name: 'music',
  enabled: true,
  page: 'post',
  async init() {
    if (document.querySelectorAll('.music-track').length > 0) {
      const { initMusicPlayer } = await import('./music.js');
      initMusicPlayer();
    }
  },
});

register({
  name: 'likes',
  enabled: true,
  page: 'post',
  async init() {
    if ($('.like-button')) {
      const apiBase = document.querySelector('meta[name="api-base"]')?.content;
      const { initLikes } = await import('./likes.js');
      const updateLikes = initLikes({ apiBase });
      const slug = document.body.dataset.slug;
      // Pull live view/like counts from the Worker and patch the SSR numbers
      if (slug && apiBase) {
        try {
          const resp = await fetch(`${apiBase}/stats/${encodeURIComponent(slug)}`, { cache: 'no-store' });
          if (resp.ok) {
            const d = await resp.json();
            const v = document.getElementById('mosaic-views-display');
            if (v && d.views != null) v.textContent = d.views;
            const l = document.getElementById('like-count-display');
            if (l && d.likes != null) l.textContent = d.likes;
            updateLikes?.(d.likes);
          }
        } catch {
          /* keep SSR fallback */
        }
      }
    }
  },
});

register({
  name: 'stats',
  enabled: true,
  page: 'post',
  async init() {
    const { initStats } = await import('./stats.js');
    const apiBase = document.querySelector('meta[name="api-base"]')?.content;
    initStats({ apiBase });
  },
});

register({
  name: 'filter',
  enabled: true,
  page: 'list',
  async init() {
    const input = document.querySelector('.search-input');
    let pendingQuery = input?.value || '';
    const capture = () => {
      pendingQuery = input.value;
    };
    input?.addEventListener('input', capture);
    let posts;
    try {
      const response = await fetch(`${DATA_BASE}/posts-index.json`);
      if (!response.ok) throw new Error(`Index HTTP ${response.status}`);
      posts = await response.json();
    } catch {
      input?.removeEventListener('input', capture);
      if (input) input.placeholder = tFallback();
      return;
    }
    setPosts(posts);
    initFilter(posts);
    input?.removeEventListener('input', capture);
    if (window.__MOSAIC_CONFIG?.components?.search?.enabled !== false) {
      initSearch(posts);
      if (pendingQuery) input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.documentElement.dataset.interactive = 'ready';
  },
});

/**
 * List-page experience layers. Both modules are idempotent, feature-flag
 * themselves and no-op outside list pages, so wiring them unconditionally is
 * safe (and keeps this orchestrator tiny).
 */
function initListExperience() {
  // Masonry packs cards into balanced columns (JS because Safari mis-sizes
  // aspect-ratio cards inside CSS multi-column); LQIPs then upgrade to HD.
  safe('masonry', () => initMasonry());
  safe('card-media', () => initCardMedia());
  safe('note-modal', () => {
    const note = initNoteModal();
    return () => note?.dispose?.();
  });
  safe('vertical-feed', () => {
    const feed = initVerticalFeed();
    return () => feed?.dispose?.();
  });
}

function tFallback() {
  return window.__LANG === 'en' ? 'Search unavailable — reload to retry' : '搜索暂不可用，请刷新重试';
}

/**
 * Morphicons is bundled by esbuild in production, but the icon module uses a
 * bare package specifier, which only resolves through the bundle. Load it
 * dynamically so the source-module page (and any bundle-less deployment) still
 * initializes everything else; icons are a progressive enhancement.
 */
function initMorphIcons() {
  import('./icons/index.js')
    .then(({ initIcons }) => safe('icons', () => initIcons()))
    .catch((error) => console.warn('[app] Morphicons unavailable:', error?.message || error));
}

async function init() {
  // Page chrome first: pre-paint bootstrap already resolved theme/accent, these
  // calls only attach behavior and state. Order matters: theme publishes the
  // resolved state, icons hydrate against it, motion enables reveal states.
  safe('theme', () => {
    initTheme();
    initMotion();
    const themeMenuToggle = document.getElementById('theme-menu-toggle');
    const themeToggle = document.getElementById('theme-toggle');
    if (themeMenuToggle) return initThemeMenu();
    if (themeToggle) {
      themeToggle.addEventListener('click', cycleTheme);
      return () => themeToggle.removeEventListener('click', cycleTheme);
    }
    return null;
  });
  initMorphIcons();

  if (PAGE_TYPE === 'list') initListExperience();

  try {
    await loadComponents(window.__MOSAIC_CONFIG?.components || {}, PAGE_TYPE);
  } catch (err) {
    console.error('App init failed:', err);
    const grid = $('.card-grid');
    if (grid) grid.innerHTML = '<div class="empty-state"><i class="ri-inbox-line"></i><p>Failed to load.</p></div>';
  }
}

/** Tear down page-scoped listeners before the document is discarded. */
function disposeAll() {
  while (disposers.length) {
    const dispose = disposers.pop();
    try {
      dispose?.();
    } catch {
      /* noop */
    }
  }
}
window.addEventListener('pagehide', disposeAll, { once: true });

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch(console.error));
} else {
  init().catch(console.error);
}
