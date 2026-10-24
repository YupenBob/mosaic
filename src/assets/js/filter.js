/**
 * Category / tag filtering for list pages.
 *
 * Thin UI wiring only: filter rules live in `cards/state.js`, DOM rendering in
 * `cards/grid.js`, and card markup in `cards/render.js` (shared with SSR).
 *
 * @module filter
 */
import { $, $$ } from './utils.js';
import { getPosts } from './data.js';
import {
  filterPosts,
  getFilterState,
  initialStateFrom,
  toggleCategory,
  toggleTag,
  updateFilterState as setFilterState,
} from './cards/state.js';
import { renderGrid } from './cards/grid.js';

let wired = false;

/** Sync the pill UI (active class + aria-pressed) with the filter state. */
function updateFilterUI() {
  const state = getFilterState();
  $$('.filter-pill[data-category]').forEach((pill) => {
    const active = pill.dataset.category === state.activeCategory;
    pill.classList.toggle('active', active);
    pill.setAttribute('aria-pressed', String(active));
  });
  $$('.filter-pill[data-tag]').forEach((pill) => {
    const active = state.activeTags.has(pill.dataset.tag);
    pill.classList.toggle('active', active);
    pill.setAttribute('aria-pressed', String(active));
  });
}

/**
 * Initialize filtering on a list page. Idempotent: event listeners are wired
 * once, later calls only refresh state/UI.
 *
 * @param {Array<Record<string, unknown>>} posts lite listing posts
 */
export function initFilter(posts) {
  const state = initialStateFrom({
    search: window.location.search,
    category: document.body.dataset.category,
    tag: document.body.dataset.tag,
  });
  setFilterState(state);

  if (!wired) {
    wired = true;
    const categoryContainer = $('.filter-categories');
    const tagContainer = $('.filter-tags');
    if (categoryContainer) {
      categoryContainer.addEventListener('click', (event) => {
        const pill = event.target.closest('.filter-pill[data-category]');
        if (!pill) return;
        toggleCategory(pill.dataset.category);
        updateFilterUI();
        renderCards(getPosts() || posts);
      });
    }
    if (tagContainer) {
      tagContainer.addEventListener('click', (event) => {
        const pill = event.target.closest('.filter-pill[data-tag]');
        if (!pill) return;
        toggleTag(pill.dataset.tag);
        updateFilterUI();
        renderCards(getPosts() || posts);
      });
    }
  }
  updateFilterUI();
}

/**
 * Back-compat export used by `search.js`: merge a partial filter state.
 * @param {Parameters<typeof setFilterState>[0]} newState
 */
export function updateFilterState(newState) {
  setFilterState(newState);
}

/**
 * Posts matching the current category/tag/search state.
 * @param {Array<Record<string, unknown>>} posts
 * @returns {Array<Record<string, unknown>>}
 */
export function getFilteredPosts(posts) {
  return filterPosts(posts || getPosts());
}

/**
 * Re-render the card grid for a post list (shared markup + motion + a11y
 * result announcement).
 * @param {Array<Record<string, unknown>>} posts
 */
export function renderCards(posts) {
  renderGrid(filterPosts(posts || getPosts()));
}
