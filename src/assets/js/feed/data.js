/**
 * Feed payload access (`data/feed.json`, contract §6) + small shared helpers.
 * Fetched lazily: the entry button only appears once the payload is known to
 * contain playable items, and opening the overlay reuses the cached payload.
 */

/** @type {Promise<Array<object>>|null} */
let pending = null;
/** @type {Array<object>} */
let items = [];

/** @returns {string} base path to the generated data directory */
export function dataBase() {
  const content = document.querySelector('meta[name="data-base"]')?.content || 'data';
  return content.replace(/\/+$/, '');
}

/** @returns {string} relative path back to the dist root ('' | '../' | '../../') */
export function siteBase() {
  const stripped = dataBase().replace(/\/?data$/, '');
  return stripped ? stripped.replace(/\/+$/, '') + '/' : '';
}

/** @param {string} slug @returns {string} */
export function postUrl(slug) {
  return `${siteBase()}posts/${encodeURIComponent(slug)}/`;
}

/** @param {string[]} tags @returns {string} */
export function primaryTag(tags) {
  return Array.isArray(tags) && tags.length ? tags[0] : '';
}

/** @returns {boolean} low-network / data-saver hint (best effort) */
export function lowNetwork() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return false;
  return connection.saveData === true || /^(slow-2g|2g|3g)$/.test(connection.effectiveType || '');
}

/**
 * Fetch the feed payload once. Rejects are not cached so a retry can succeed.
 * @returns {Promise<Array<object>>}
 */
export function loadFeed() {
  if (items.length) return Promise.resolve(items);
  if (!pending) {
    pending = fetch(`${dataBase()}/feed.json`, { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error(`Feed HTTP ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        items = (Array.isArray(payload?.items) ? payload.items : []).filter(
          (item) => item && item.slug && item.sources && Object.keys(item.sources).length,
        );
        return items;
      })
      .catch((error) => {
        pending = null;
        throw error;
      });
  }
  return pending;
}

/** @param {string} slug @returns {string} absolute deep link to a post */
export function shareUrl(slug) {
  return new URL(postUrl(slug), window.location.href).toString();
}

/** Test/teardown helper. */
export function clearFeedCache() {
  pending = null;
  items = [];
}
