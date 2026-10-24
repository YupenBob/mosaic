/**
 * Lazy note-detail data access + URL helpers for the note modal.
 *
 * Each note is a static build artifact (`data/notes/<slug>.json`, contract §6),
 * fetched on first open and cached in memory for the session. Nothing here runs
 * at app start: the modal only calls these helpers when it is actually opened.
 */

/** @type {Map<string, Promise<object>>} */
const cache = new Map();

/**
 * Base path to the generated `data/` directory. index.ejs exposes it as a
 * `<meta name="data-base">` so paginated/category pages (which live one or two
 * levels deep) resolve it through the browser without hard-coded prefixes.
 * @returns {string}
 */
export function dataBase() {
  const content = document.querySelector('meta[name="data-base"]')?.content || 'data';
  return content.replace(/\/+$/, '');
}

/**
 * Relative path back to the dist root ('' | '../' | '../../').
 * @returns {string}
 */
export function siteBase() {
  const stripped = dataBase().replace(/\/?data$/, '');
  return stripped ? stripped.replace(/\/+$/, '') + '/' : '';
}

/**
 * Canonical post URL for a slug, resolved from the current page depth.
 * @param {string} slug
 * @returns {string}
 */
export function postUrl(slug) {
  return `${siteBase()}posts/${encodeURIComponent(slug)}/`;
}

/**
 * Shareable absolute URL for a note deep link.
 * @param {string} slug
 * @returns {string}
 */
export function shareUrl(slug) {
  const url = new URL(window.location.href);
  url.searchParams.set('note', slug);
  url.hash = '';
  return url.toString();
}

/**
 * Fetch (and cache) one note payload.
 * Rejected fetches are evicted so a later open can retry.
 *
 * @param {string} slug
 * @returns {Promise<object>}
 */
export function loadNote(slug) {
  const key = String(slug);
  if (!cache.has(key)) {
    const request = fetch(`${dataBase()}/notes/${encodeURIComponent(key)}.json`, {
      credentials: 'same-origin',
    }).then((response) => {
      if (!response.ok) throw new Error(`Note HTTP ${response.status}`);
      return response.json();
    });
    request.catch(() => cache.delete(key));
    cache.set(key, request);
  }
  return cache.get(key);
}

/** Test/teardown helper: drop cached payloads. */
export function clearNoteCache() {
  cache.clear();
}

/** Slug currently present in the URL (?note=…), decoded, or ''. */
export function slugFromLocation() {
  return new URLSearchParams(window.location.search).get('note') || '';
}

/**
 * Resolve a slug from a card link without depending on the card's inner markup.
 * @param {HTMLAnchorElement} card
 * @returns {string}
 */
export function slugFromCard(card) {
  if (card.dataset?.slug) return card.dataset.slug;
  const href = card.getAttribute('href') || '';
  const match = /(?:^|\/)posts\/([^/?#]+)\/?$/.exec(href);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
