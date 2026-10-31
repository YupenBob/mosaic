/**
 * Client-side search with a pre-built JSON index.
 *
 * The input is a WAI-ARIA combobox: the dropdown is a listbox, options are
 * announced through `aria-activedescendant`, and focus never leaves the input.
 * Keyboard support:
 *   ↓ / ↑   move through results
 *   Enter   open the active result (first result when none is active)
 *   Esc     close the dropdown (a second Esc clears the query)
 *   /       focus search from anywhere on the page (unless already typing)
 *
 * IME composition (Chinese/Japanese/Korean input) is tracked explicitly: an
 * in-flight composition never filters the grid or opens the dropdown, so a
 * half-typed pinyin string cannot flash empty results.
 *
 * @module search
 */
import { $, escapeHTML, highlightTerm } from './utils.js';
import { t } from './data.js';
import { getFilteredPosts, renderCards, updateFilterState } from './filter.js';

/** @param {unknown} value @param {number} fallback @returns {number} */
function configNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const MIN_CHARS = () => configNumber(window.__MOSAIC_CONFIG?.searchMinChars, 2);
const MAX_RESULTS = () => configNumber(window.__MOSAIC_CONFIG?.search?.maxResults, 10);
const DEBOUNCE_MS = () => configNumber(window.__MOSAIC_CONFIG?.search?.debounceMs, 250);

/** Input types that already own typing; the `/` shortcut must not steal them. */
const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * @param {EventTarget|null} element
 * @returns {boolean} true when the element accepts free text
 */
function isEditable(element) {
  return Boolean(
    element &&
    (EDITABLE.has(/** @type {HTMLElement} */ (element).tagName) ||
      /** @type {HTMLElement} */ (element).isContentEditable ||
      /** @type {HTMLElement} */ (element).getAttribute?.('role') === 'textbox'),
  );
}

/**
 * Initialize the search box. Idempotent; safe to call twice.
 * @param {Array<Record<string, unknown>>} allPosts lite listing posts
 * @returns {(() => void)|undefined} dispose
 */
export function initSearch(allPosts) {
  const input = /** @type {HTMLInputElement|null} */ ($('.search-input'));
  if (!input || input.dataset.searchReady === 'true') return;
  input.dataset.searchReady = 'true';

  const container = input.closest('.search-container') || input.parentElement;
  if (!container) return;

  // Reuse a server-rendered dropdown when present; create it otherwise so
  // source-module deployments behave exactly like bundled ones.
  let dropdown = container.querySelector('.search-results-dropdown');
  if (!dropdown) {
    dropdown = document.createElement('div');
    dropdown.className = 'search-results-dropdown';
    container.appendChild(dropdown);
  }
  dropdown.id = 'search-results';
  dropdown.setAttribute('role', 'listbox');
  dropdown.setAttribute('aria-label', t('search_results_label'));

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', dropdown.id);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('enterkeyhint', 'search');

  const shortcut = document.createElement('kbd');
  shortcut.className = 'search-shortcut';
  shortcut.setAttribute('aria-hidden', 'true');
  shortcut.textContent = '/';
  const wrapper = input.closest('.search-input-wrapper');
  if (wrapper) wrapper.appendChild(shortcut);

  /** @type {HTMLElement[]} */
  let options = [];
  let activeIndex = -1;
  /** @type {number|undefined} */
  let timer;
  let composing = false;
  /** Query whose results are currently in the DOM ('' when none). */
  let renderedQuery = '';

  /** @param {boolean} expanded */
  function setExpanded(expanded) {
    dropdown.classList.toggle('show', expanded);
    input.setAttribute('aria-expanded', String(expanded));
    if (!expanded) {
      input.removeAttribute('aria-activedescendant');
      activeIndex = -1;
      options.forEach((option) => {
        option.setAttribute('aria-selected', 'false');
        option.classList.remove('is-active');
      });
    }
  }

  /** @param {number} index @param {{scroll?: boolean}} [opts] */
  function setActive(index, opts = {}) {
    if (!options.length) return;
    activeIndex = (index + options.length) % options.length;
    options.forEach((option, i) => {
      const active = i === activeIndex;
      option.setAttribute('aria-selected', String(active));
      option.classList.toggle('is-active', active);
    });
    const option = options[activeIndex];
    input.setAttribute('aria-activedescendant', option.id);
    if (opts.scroll) option.scrollIntoView({ block: 'nearest' });
  }

  /** Reset the listbox DOM and state without touching the grid. */
  function clearOptions() {
    options = [];
    renderedQuery = '';
    dropdown.replaceChildren();
    setExpanded(false);
  }

  /** Move the active option, wrapping around both ends. @param {number} delta */
  function move(delta) {
    const query = input.value.trim();
    // Nothing current rendered (Esc closed it, or the debounce is still
    // pending): search synchronously so the very first ArrowDown works.
    if (query.length >= MIN_CHARS() && (renderedQuery !== query || !options.length)) runSearch(query);
    if (!options.length) return;
    if (!dropdown.classList.contains('show')) setExpanded(true);
    setActive(activeIndex < 0 ? (delta > 0 ? 0 : options.length - 1) : activeIndex + delta, { scroll: true });
  }

  /** Navigate to the active option, defaulting to the first one. */
  function chooseActive() {
    const option = options[activeIndex >= 0 ? activeIndex : 0];
    if (option instanceof HTMLAnchorElement) window.location.assign(option.href);
  }

  /**
   * Render matching posts into the listbox.
   * @param {Array<Record<string, unknown>>} posts
   * @param {string} query
   */
  function renderResults(posts, query) {
    renderedQuery = query;
    if (!posts.length) {
      dropdown.innerHTML = `<div class="search-result-empty" role="presentation">${escapeHTML(t('no_results'))}</div>`;
      options = [];
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      setExpanded(true);
      return;
    }

    const dataBase = document.querySelector('meta[name="data-base"]')?.content || 'data';
    const base = dataBase === 'data' ? '' : dataBase.replace(/\/?data$/, '');
    dropdown.innerHTML = posts
      .map(
        (post, index) =>
          `<a href="${base}posts/${post.slug}/" class="search-result-item" id="search-option-${index}" role="option" aria-selected="false" tabindex="-1">` +
          `<div class="search-result-title">${highlightTerm(post.title, query)}</div>` +
          `<div class="search-result-meta">${escapeHTML(post.category)} &middot; ${(post.tags || [])
            .map((tag) => escapeHTML(tag))
            .join(', ')}</div>` +
          '</a>',
      )
      .join('');
    options = Array.from(dropdown.querySelectorAll('.search-result-item'));
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant');
    dropdown.scrollTop = 0;
    setExpanded(true);
  }

  /**
   * Apply the current query to both the grid and the dropdown.
   * Stale debounced calls are ignored by comparing against the live input.
   * @param {string} rawQuery
   */
  function runSearch(rawQuery) {
    const query = rawQuery.trim();
    if (query !== input.value.trim()) return;
    updateFilterState({ searchQuery: query });

    if (query.length < MIN_CHARS()) {
      clearOptions();
    } else {
      renderResults(getFilteredPosts(allPosts).slice(0, MAX_RESULTS()), query);
    }
    renderCards(allPosts);
  }

  /** Clear the query, restore every card and close the listbox. */
  function clearSearch() {
    window.clearTimeout(timer);
    updateFilterState({ searchQuery: '' });
    clearOptions();
    renderCards(allPosts);
  }

  function onInput() {
    if (composing) return;
    const query = input.value.trim();
    if (!query) {
      clearSearch();
      return;
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(() => runSearch(query), DEBOUNCE_MS());
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    if (event.isComposing || composing) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Enter':
        if (dropdown.classList.contains('show') && options.length) {
          event.preventDefault();
          chooseActive();
        }
        break;
      case 'Escape':
        if (dropdown.classList.contains('show')) {
          event.preventDefault();
          event.stopPropagation();
          setExpanded(false);
        } else if (input.value) {
          // Second Esc clears instead of leaving a stale filter behind.
          event.preventDefault();
          input.value = '';
          clearSearch();
        }
        break;
      case 'Tab':
        setExpanded(false);
        break;
      default:
        break;
    }
  }

  /** @param {FocusEvent} event */
  function onFocusOut(event) {
    const next = event.relatedTarget;
    if (next instanceof Node && container.contains(next)) return;
    setExpanded(false);
  }

  function onFocus() {
    if (input.value.trim() && options.length) setExpanded(true);
  }

  /** @param {Event} event */
  function onOptionHover(event) {
    const option = /** @type {HTMLElement} */ (event.target).closest?.('.search-result-item');
    if (!option) return;
    const index = options.indexOf(option);
    if (index >= 0) setActive(index);
  }

  function onCompositionStart() {
    composing = true;
  }

  function onCompositionEnd() {
    composing = false;
    onInput();
  }

  /** Pointer outside the widget closes the listbox. @param {PointerEvent} event */
  function onDocumentPointerDown(event) {
    if (!(event.target instanceof Node) || container.contains(event.target)) return;
    setExpanded(false);
  }

  /** `/` jumps to search from anywhere on the page. @param {KeyboardEvent} event */
  function onDocumentKeyDown(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key !== '/' || isEditable(event.target)) return;
    // Never steal focus from an open modal/feed (they own the focus trap).
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    input.focus();
    input.select();
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('focus', onFocus);
  input.addEventListener('focusout', onFocusOut);
  input.addEventListener('compositionstart', onCompositionStart);
  input.addEventListener('compositionend', onCompositionEnd);
  dropdown.addEventListener('mouseover', onOptionHover);
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeyDown);

  // Apply any pre-filled query (restored form state, bfcache) once.
  if (input.value.trim()) onInput();

  return () => {
    window.clearTimeout(timer);
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeyDown);
    input.removeEventListener('focus', onFocus);
    input.removeEventListener('focusout', onFocusOut);
    input.removeEventListener('compositionstart', onCompositionStart);
    input.removeEventListener('compositionend', onCompositionEnd);
    dropdown.removeEventListener('mouseover', onOptionHover);
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeyDown);
    shortcut.remove();
    delete input.dataset.searchReady;
  };
}
