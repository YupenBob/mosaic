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
register({ name: 'gallery', enabled: true, page: 'post',
  async init(el, cfg) {
    if ($('.gallery-grid, .gallery-single')) {
      const { initGallery } = await import('./gallery.js');
      initGallery();
    }
  }
});

register({ name: 'video', enabled: true, page: 'post',
  async init(el, cfg) {
    if (document.querySelectorAll('.video-container').length > 0) {
      const { initVideoPlayers } = await import('./video.js');
      initVideoPlayers();
    }
  }
});

register({ name: 'likes', enabled: true, page: 'post',
  async init(el, cfg) {
    if ($('.like-button')) {
      const { initLikes } = await import('./likes.js');
      initLikes();
    }
  }
});

register({ name: 'stats', enabled: true, page: 'post',
  async init(el, cfg) {
    const { initStats } = await import('./stats.js');
    initStats();
  }
});

register({ name: 'filter', enabled: true, page: 'list',
  async init(el, cfg) {
    const posts = await fetch(`${DATA_BASE}/posts.json?t=${Date.now()}`, { cache: 'no-cache' }).then(r => r.json()).catch(() => []);
    setPosts(posts);
    const { initFilter } = await import('./filter.js');
    initFilter(posts);
    const { initSearch } = await import('./search.js');
    initSearch(posts);
  }
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
