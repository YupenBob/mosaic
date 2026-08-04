/**
 * Mosaic App — thin orchestrator, delegates to components.
 */
import { $ } from './utils.js';
import { setPosts, initI18n } from './data.js';
import { register, loadComponents } from './components.js';

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
      initGallery();
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
            const likeBtn = document.querySelector('.like-button');
            if (likeBtn && d.likes != null) likeBtn.dataset.count = d.likes;
            const lc = likeBtn?.querySelector('.like-count');
            if (lc && likeBtn && !likeBtn.classList.contains('liked') && d.likes != null) lc.textContent = d.likes;
          }
        } catch {
          /* keep SSR fallback */
        }
      }
      const { initLikes } = await import('./likes.js');
      initLikes({ apiBase });
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
    const posts = await fetch(`${DATA_BASE}/posts.json?t=${Date.now()}`, { cache: 'no-cache' })
      .then((r) => r.json())
      .catch(() => []);
    setPosts(posts);
    const { initFilter } = await import('./filter.js');
    initFilter(posts);
    const { initSearch } = await import('./search.js');
    initSearch(posts);
  },
});

async function init() {
  const pageType = document.body.dataset.page || 'list';
  try {
    await loadComponents(null, pageType);
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
