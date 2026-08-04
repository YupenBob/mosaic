/**
 * Client-side search with pre-built JSON index
 */
import { $, debounce, escapeHTML, highlightTerm } from './utils.js';
import { updateFilterState, renderCards } from './filter.js';
export function initSearch(allPosts) {
  const searchInput = $('.search-input');
  if (!searchInput) return;

  let searchDropdown = null;

  const handleSearch = debounce((query) => {
    updateFilterState({ searchQuery: query });

    if (query.length > 0) {
      import('./filter.js')
        .then(({ getFilteredPosts }) => {
          renderSearchResults(getFilteredPosts(allPosts).slice(0, 10), query);
        })
        .catch(() => {});
    } else {
      hideDropdown();
    }

    renderCards(allPosts);
  }, 250);

  // Build dropdown
  searchDropdown = document.createElement('div');
  searchDropdown.className = 'search-results-dropdown';
  if (searchInput.parentElement) {
    searchInput.parentElement.appendChild(searchDropdown);
  }

  searchInput.addEventListener('focus', () => {
    if (searchInput.value.length > 0) {
      searchDropdown.classList.add('show');
    }
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (q.length === 0) {
      hideDropdown();
      updateFilterState({ searchQuery: '' });
      renderCards(allPosts);
      return;
    }
    handleSearch(q);
  });

  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target)) {
      hideDropdown();
    }
  });
}

function renderSearchResults(posts, query) {
  const dropdown = $('.search-results-dropdown');
  if (!dropdown) return;

  const dataBase = document.querySelector('meta[name="data-base"]')?.content || 'data';
  const base = dataBase === 'data' ? '' : dataBase.replace(/\/?data$/, '');

  if (posts.length === 0) {
    dropdown.innerHTML =
      '<div class="search-result-item"><span style="color:var(--color-text-tertiary)">' +
      'No results' +
      '</span></div>';
  } else {
    dropdown.innerHTML = posts
      .map(
        (p) =>
          '<a href="' +
          base +
          'posts/' +
          p.slug +
          '/" class="search-result-item">' +
          '<div class="search-result-title">' +
          highlightTerm(p.title, query) +
          '</div>' +
          '<div class="search-result-meta">' +
          escapeHTML(p.category) +
          ' &middot; ' +
          (p.tags || []).map((t) => escapeHTML(t)).join(', ') +
          '</div>' +
          '</a>',
      )
      .join('');
  }
  dropdown.classList.add('show');
}

function hideDropdown() {
  const dropdown = $('.search-results-dropdown');
  if (dropdown) dropdown.classList.remove('show');
}
