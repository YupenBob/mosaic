/**
 * Mosaic App — thin orchestrator, delegates to components.
 */
import { $ } from './utils.js';
import { setPosts, initI18n } from './data.js';
import { register, loadComponents } from './components.js';
import { initTheme, cycleTheme } from './theme.js';
import { initFilter } from './filter.js';
import { initSearch } from './search.js';

const DATA_BASE = document.querySelector('meta[name="data-base"]')?.content || '/data';

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

function tFallback() {
  return window.__LANG === 'en' ? 'Search unavailable — reload to retry' : '搜索暂不可用，请刷新重试';
}

async function init() {
  const pageType = document.body.dataset.page || 'list';
  initTheme();
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) themeToggle.addEventListener('click', cycleTheme);
  try {
    await loadComponents(window.__MOSAIC_CONFIG?.components || {}, pageType);
  } catch (err) {
    console.error('App init failed:', err);
    const grid = $('.card-grid');
    if (grid) grid.innerHTML = '<div class="empty-state"><i class="ri-inbox-line"></i><p>Failed to load.</p></div>';
  }
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch(console.error));
} else {
  init().catch(console.error);
}
