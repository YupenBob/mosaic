/**
 * DOM rendering for the list grid.
 *
 * Re-renders use the exact same markup module as SSR
 * (`cards/render.js`), so filter/search results never drift from the
 * server-rendered cards. Also handles the accessible result announcement.
 *
 * @module cards/grid
 */
import { renderCards, renderEmptyState } from './render.js';
import { upgradeCardMedia } from './media.js';
import { layoutMasonry } from './masonry.js';
import { getPosts, t } from '../data.js';
import { revealAll, withViewTransition } from '../motion/index.js';

/**
 * Relative prefix back to the site root, derived from `<meta data-base>`
 * (mirrors the EJS `rp` value: '', '../', '../../').
 * @returns {string}
 */
export function siteBase() {
  const dataBase = document.querySelector('meta[name="data-base"]')?.content || 'data';
  return dataBase === 'data' ? '' : dataBase.replace(/\/?data$/, '');
}

/** Accessible status line for filter/search result changes. */
function statusRegion() {
  let region = document.getElementById('card-grid-status');
  if (!region) {
    region = document.createElement('p');
    region.id = 'card-grid-status';
    region.className = 'sr-only';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    const grid = document.getElementById('card-grid') || document.querySelector('.card-grid');
    if (grid?.parentNode) grid.parentNode.insertBefore(region, grid.nextSibling);
    else document.body.append(region);
  }
  return region;
}

/** Replace the grid content (shared by initial filter interactions). */
function paint(grid, posts, base) {
  if (!posts.length) {
    grid.innerHTML = renderEmptyState(getPosts().length ? t('no_results') : t('no_posts'));
  } else {
    grid.innerHTML = renderCards(posts, { base });
    // New DOM: re-pack the masonry columns, then start progressive LQIP upgrades.
    layoutMasonry(grid);
    upgradeCardMedia(grid);
  }
  revealAll(grid);
  const label = !posts.length
    ? getPosts().length
      ? t('no_results')
      : t('no_posts')
    : t('results_count').replace('{count}', String(posts.length));
  statusRegion().textContent = label;
}

/**
 * Render the filtered posts into the card grid.
 *
 * Uses a View Transition when the browser supports it (progressive
 * enhancement; falls back to an instant update, and is disabled under
 * reduced motion by the motion module).
 *
 * @param {Array<Record<string, unknown>>} posts already-filtered lite posts
 * @param {{ grid?: HTMLElement|null, animate?: boolean }} [options]
 */
export function renderGrid(posts, options = {}) {
  const grid = options.grid || document.querySelector('.card-grid');
  if (!grid) return;
  const animate = options.animate !== false;
  let painted = false;
  const update = () => {
    paint(grid, posts, siteBase());
    painted = true;
  };
  if (animate) {
    withViewTransition(update);
    // View Transitions invoke the update asynchronously; if the API is
    // unavailable the helper runs it synchronously. Reveal again on the next
    // frame for safety so no freshly inserted card can stay hidden.
    if (!painted) requestAnimationFrame(() => revealAll(grid));
  } else {
    update();
  }
}
