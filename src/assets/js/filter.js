/**
 * Category and tag filtering for list pages
 */
import { $, $$, formatNumber, escapeHTML } from './utils.js';
import { getPosts } from './data.js';

let filterState = {
  activeCategory: '',
  activeTags: new Set(),
  searchQuery: '',
};

export function initFilter(posts) {
  const urlParams = new URLSearchParams(window.location.search);
  const categoryFromURL = urlParams.get('category');
  const tagFromURL = urlParams.get('tag');

  if (categoryFromURL) filterState.activeCategory = categoryFromURL;
  if (tagFromURL) filterState.activeTags.add(tagFromURL);

  const pageCategory = document.body.dataset.category;
  const pageTag = document.body.dataset.tag;
  if (pageCategory) filterState.activeCategory = pageCategory;
  if (pageTag) filterState.activeTags.add(pageTag);

  const categoryContainer = $('.filter-categories');
  const tagContainer = $('.filter-tags');

  if (categoryContainer) {
    categoryContainer.addEventListener('click', (e) => {
      const pill = e.target.closest('.filter-pill');
      if (!pill) return;
      const cat = pill.dataset.category;
      filterState.activeCategory = filterState.activeCategory === cat ? '' : cat;
      updateFilterUI();
      renderCards(getPosts() || posts);
    });
  }

  if (tagContainer) {
    tagContainer.addEventListener('click', (e) => {
      const pill = e.target.closest('.filter-pill');
      if (!pill) return;
      const tag = pill.dataset.tag;
      filterState.activeTags.has(tag) ? filterState.activeTags.delete(tag) : filterState.activeTags.add(tag);
      updateFilterUI();
      renderCards(getPosts() || posts);
    });
  }

  updateFilterUI();
}

export function updateFilterState(newState) {
  Object.assign(filterState, newState);
}

export function getFilteredPosts(posts) {
  let filtered = [...posts];
  if (filterState.activeCategory) {
    filtered = filtered.filter((p) => p.category === filterState.activeCategory);
  }
  if (filterState.activeTags.size > 0) {
    filtered = filtered.filter((p) => p.tags.some((t) => filterState.activeTags.has(t)));
  }
  if (filterState.searchQuery) {
    const q = filterState.searchQuery.toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q))
    );
  }
  return filtered;
}

export function renderCards(posts) {
  const filtered = getFilteredPosts(posts);
  const grid = $('.card-grid');
  if (!grid) return;

  // Compute base path for links (same as EJS relativePath)
  const dataBase = document.querySelector('meta[name="data-base"]')?.content || 'data';
  const base = dataBase === 'data' ? '' : dataBase.replace(/\/?data$/, '');

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-state"><i class="ri-inbox-line"></i><p>' + (getPosts().length ? 'No results' : 'No posts') + '</p></div>';
    return;
  }

  grid.innerHTML = filtered.map((post) => {
    if (!post) return '';
    const tags = post.tags || [];
    const stats = post.stats || {};
    const hasCover = !!post.cover;
    const aspect = post.coverAspect || 1.778;
    const pt = (100 / aspect).toFixed(2);
    let coverHTML = '';
    if (hasCover) {
      const src = base + 'posts/' + post.slug + '/' + post.cover;
      const srcset = post.coverSrcset
        ? ' srcset="' + base + 'posts/' + post.slug + '/' + post.coverSrcset['480'] + ' 480w, ' + base + 'posts/' + post.slug + '/' + post.coverSrcset['720'] + ' 720w, ' + base + 'posts/' + post.slug + '/' + post.coverSrcset['1080'] + ' 1080w" sizes="(max-width:640px) 100vw, (max-width:1024px) 50vw, 33vw"'
        : '';
      coverHTML = '<div class="post-card-cover" style="padding-top:' + pt + '%"><img src="' + src + '"' + srcset + ' alt="' + escapeHTML(post.title) + '" loading="lazy" /></div>';
    }
    return '<a href="' + base + 'posts/' + post.slug + '/" class="post-card' + (hasCover ? '' : ' post-card-text') + '">' +
      coverHTML +
      '<div class="post-card-body">' +
      '<span class="post-card-category">' + escapeHTML(post.category || '') + '</span>' +
      '<h3 class="post-card-title">' + escapeHTML(post.title || '') + '</h3>' +
      '<p class="post-card-desc">' + escapeHTML(post.description || '') + '</p>' +
      '<div class="post-card-tags">' +
      tags.map((t) => '<span class="post-card-tag">' + escapeHTML(t) + '</span>').join('') +
      '</div></div>' +
      '<div class="post-card-footer">' +
      '<span class="post-card-stat"><i class="ri-eye-line"></i>' + formatNumber(stats.views) + '</span>' +
      '<span class="post-card-stat"><i class="ri-time-line"></i>' + (stats.dwell_time || 0) + 's</span>' +
      '<span class="post-card-stat"><i class="ri-heart-line"></i>' + formatNumber(stats.likes) + '</span>' +
      '</div></a>';
  }).join('');
}

function updateFilterUI() {
  $$('.filter-pill[data-category]').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.category === filterState.activeCategory);
  });
  $$('.filter-pill[data-tag]').forEach((pill) => {
    pill.classList.toggle('active', filterState.activeTags.has(pill.dataset.tag));
  });
}
