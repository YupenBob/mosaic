/**
 * App bootstrap - determines page type and initializes modules
 */
import { $ } from './utils.js';

const DATA_BASE = document.querySelector('meta[name="data-base"]')?.content || '/data';

async function init() {
  const pageType = document.body.dataset.page;

  switch (pageType) {
    case 'list':
      await initListPage();
      break;
    case 'post':
      await initPostPage();
      break;
    default:
      break;
  }
}

async function initListPage() {
  // Fetch posts data
  try {
    const resp = await fetch(`${DATA_BASE}/posts.json?t=${Date.now()}`, { cache: 'no-cache' });
    const posts = await resp.json();
    window.__POSTS = posts;

    // Load filter module
    const { initFilter } = await import('./filter.js');
    initFilter(posts);

    // Load search module
    const { initSearch } = await import('./search.js');
    initSearch(posts);
  } catch (err) {
    console.error('Failed to load posts:', err);
    showEmptyState(window.__I18N?.failed_load?.[window.__LANG] || 'Failed to load content.');
  }
}

async function initPostPage() {
  try {
    const galleryEl = $('.gallery-grid, .gallery-single');
    if (galleryEl) {
      const { initGallery } = await import('./gallery.js');
      initGallery();
    }

    const videoEls = document.querySelectorAll('.video-container');
    if (videoEls.length > 0) {
      const { initVideoPlayers } = await import('./video.js');
      initVideoPlayers();
    }

    const likeBtn = $('.like-button');
    if (likeBtn) {
      const { initLikes } = await import('./likes.js');
      initLikes();
    }

    const { initStats } = await import('./stats.js');
    initStats();
  } catch (err) {
    console.error('Post page init failed:', err);
  }
}

function showEmptyState(message) {
  const grid = $('.card-grid');
  if (grid) {
    grid.innerHTML = `<div class="empty-state"><i class="ri-inbox-line"></i><p>${message}</p></div>`;
  }
}

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch((err) => console.error('App init failed:', err)));
} else {
  init().catch((err) => console.error('App init failed:', err));
}
