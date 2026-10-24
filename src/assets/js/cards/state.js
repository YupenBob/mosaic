/**
 * Pure list-page filter state and predicates.
 *
 * Kept DOM-free so the filtering rules are easy to reason about and test;
 * `filter.js` owns the UI wiring and `cards/grid.js` owns rendering.
 *
 * @module cards/state
 */

/** @typedef {{ activeCategory: string, activeTags: Set<string>, searchQuery: string }} FilterState */

/** @type {FilterState} */
const state = {
  activeCategory: '',
  activeTags: new Set(),
  searchQuery: '',
};

/** @returns {FilterState} a defensive copy of the current state */
export function getFilterState() {
  return {
    activeCategory: state.activeCategory,
    activeTags: new Set(state.activeTags),
    searchQuery: state.searchQuery,
  };
}

/** Reset to the unfiltered state (used between page-like re-inits). */
export function resetFilterState() {
  state.activeCategory = '';
  state.activeTags.clear();
  state.searchQuery = '';
}

/**
 * Merge a partial state update. Unknown keys are ignored.
 * @param {Partial<{ activeCategory: string, activeTags: Set<string>|string[], searchQuery: string }>} patch
 */
export function updateFilterState(patch = {}) {
  if (typeof patch.activeCategory === 'string') state.activeCategory = patch.activeCategory;
  if (Array.isArray(patch.activeTags)) state.activeTags = new Set(patch.activeTags);
  else if (patch.activeTags instanceof Set) state.activeTags = new Set(patch.activeTags);
  if (typeof patch.searchQuery === 'string') state.searchQuery = patch.searchQuery;
}

/**
 * Build the initial state from the URL query plus the SSR body data
 * attributes (`data-category` on category pages, `data-tag` on tag pages).
 *
 * @param {{ search?: string, category?: string, tag?: string }} [sources]
 * @returns {FilterState}
 */
export function initialStateFrom({ search = '', category = '', tag = '' } = {}) {
  const params = new URLSearchParams(search);
  return {
    activeCategory: params.get('category') || category || '',
    activeTags: new Set([params.get('tag'), tag].filter(Boolean)),
    searchQuery: '',
  };
}

/** Toggle a category (clicking the active pill clears it). */
export function toggleCategory(category) {
  if (!category) return;
  state.activeCategory = state.activeCategory === category ? '' : category;
}

/** Toggle a tag. */
export function toggleTag(tag) {
  if (!tag) return;
  if (state.activeTags.has(tag)) state.activeTags.delete(tag);
  else state.activeTags.add(tag);
}

/**
 * Apply the current filter state to a list of lite listing posts.
 * Returns a new array; never mutates the input.
 *
 * @param {Array<Record<string, unknown>>} posts
 * @returns {Array<Record<string, unknown>>}
 */
export function filterPosts(posts = []) {
  let filtered = [...posts];
  if (state.activeCategory) {
    const category = state.activeCategory;
    filtered = filtered.filter(
      (post) => post.category === category || String(post.category || '').startsWith(category + '/'),
    );
  }
  if (state.activeTags.size > 0) {
    filtered = filtered.filter((post) =>
      (Array.isArray(post.tags) ? post.tags : []).some((tag) => state.activeTags.has(tag)),
    );
  }
  const query = state.searchQuery.trim().toLowerCase();
  if (query) {
    filtered = filtered.filter((post) => {
      const title = String(post.title || '').toLowerCase();
      const description = String(post.description || '').toLowerCase();
      const tags = (Array.isArray(post.tags) ? post.tags : []).map((tag) => String(tag).toLowerCase());
      return title.includes(query) || description.includes(query) || tags.some((tag) => tag.includes(query));
    });
  }
  return filtered;
}
