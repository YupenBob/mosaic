/**
 * JavaScript masonry layout for the card grid.
 *
 * Why JS instead of relying on CSS multi-column alone: WebKit's fragmentation
 * engine mis-sizes a `break-inside: avoid` card whose height comes from
 * `aspect-ratio` when it lands on a column boundary (the card can span two
 * columns). The same bug shows up in Safari-like engines and cannot be fixed by
 * margins/containment without side effects.
 *
 * This module keeps the CSS multi-column layout as the no-JS / pre-hydration
 * fallback, then upgrades the grid to absolutely positioned cards packed into
 * the shortest column. Breakpoints and gaps stay owned by CSS via the
 * `--masonry-cols` / `--masonry-gap` custom properties, so there is a single
 * source of truth for responsive behaviour.
 *
 * @module cards/masonry
 */

/** @type {{observer: ResizeObserver|null, grid: HTMLElement|null, dispose: (() => void)|null}} */
const state = { observer: null, grid: null, dispose: null };
let scheduled = 0;

/** @param {HTMLElement} grid @returns {CSSStyleDeclaration} */
function styleOf(grid) {
  return getComputedStyle(grid);
}

/** @returns {boolean} true when the masonry layout is enabled by config */
function masonryEnabled() {
  return (document.body?.dataset.cardLayout || 'masonry') !== 'grid';
}

/**
 * Number of columns for the current viewport (owned by CSS).
 * @param {HTMLElement} grid
 * @returns {number}
 */
function columnCount(grid) {
  const raw = parseInt(styleOf(grid).getPropertyValue('--masonry-cols'), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Gap between cards (horizontal and vertical) in px.
 * @param {HTMLElement} grid
 * @returns {number}
 */
function gapSize(grid) {
  const raw = parseFloat(styleOf(grid).getPropertyValue('--masonry-gap'));
  return Number.isFinite(raw) && raw >= 0 ? raw : 24;
}

/** Reset inline geometry written by a previous layout pass. */
function resetCards(grid) {
  for (const card of grid.querySelectorAll(':scope > .post-card')) {
    card.style.removeProperty('position');
    card.style.removeProperty('width');
    card.style.removeProperty('left');
    card.style.removeProperty('top');
  }
  grid.style.removeProperty('height');
}

/**
 * Lay the cards out into balanced columns.
 *
 * Reads the column count/gap from CSS, measures each card at its final width,
 * then packs them into the currently shortest column (classic masonry). Text
 * cards are measured as-is; cover cards get their height from the media
 * aspect-ratio so no image needs to load for a correct layout.
 *
 * @param {HTMLElement|null} [grid]
 * @returns {{columns: number, height: number, placed: number}|null}
 */
export function layoutMasonry(grid = document.querySelector('.card-grid')) {
  if (!grid || !masonryEnabled()) {
    if (grid) unmasonry(grid);
    return null;
  }
  const cards = Array.from(grid.querySelectorAll(':scope > .post-card'));
  if (!cards.length) {
    unmasonry(grid);
    return null;
  }
  const width = grid.clientWidth;
  if (!width) return null;
  const columns = columnCount(grid);
  const gap = gapSize(grid);
  const columnWidth = Math.max(1, (width - gap * (columns - 1)) / columns);

  // 1) normalize + set final width before measuring (avoids per-card reflow mix)
  grid.classList.add('is-masonry');
  for (const card of cards) {
    card.style.position = 'absolute';
    card.style.width = `${columnWidth}px`;
    card.style.removeProperty('left');
    card.style.removeProperty('top');
  }

  // 2) measure heights at that width
  const heights = new Array(columns).fill(0);
  /** @type {Array<{card: HTMLElement, column: number, top: number}>} */
  const placements = [];
  for (const card of cards) {
    const height = card.offsetHeight;
    let column = 0;
    for (let i = 1; i < columns; i += 1) if (heights[i] < heights[column] - 0.5) column = i;
    const top = heights[column];
    placements.push({ card, column, top });
    heights[column] = top + height + gap;
  }

  // 3) write positions once
  for (const { card, column, top } of placements) {
    card.style.left = `${column * (columnWidth + gap)}px`;
    card.style.top = `${top}px`;
  }
  const height = Math.max(0, Math.max(...heights) - gap);
  grid.style.height = `${height}px`;
  return { columns, height, placed: cards.length };
}

/**
 * Restore the CSS fallback layout (config switched to `grid`).
 * @param {HTMLElement} grid
 */
function unmasonry(grid) {
  grid.classList.remove('is-masonry');
  resetCards(grid);
}

/** Schedule one layout pass per animation frame. */
function schedule() {
  if (scheduled) return;
  scheduled = requestAnimationFrame(() => {
    scheduled = 0;
    layoutMasonry(state.grid || document.querySelector('.card-grid'));
  });
}

/**
 * Initialize masonry layout + resize/font-react recalculation. Idempotent.
 * @param {HTMLElement|null} [grid]
 * @returns {() => void} dispose
 */
export function initMasonry(grid = document.querySelector('.card-grid')) {
  if (!grid || !masonryEnabled()) return () => {};
  state.grid = grid;
  layoutMasonry(grid);
  if (typeof ResizeObserver === 'function' && !state.observer) {
    state.observer = new ResizeObserver(schedule);
    state.observer.observe(grid);
  }
  if (document.fonts?.ready) document.fonts.ready.then(schedule).catch(() => {});
  state.dispose = () => {
    cancelAnimationFrame(scheduled);
    scheduled = 0;
    state.observer?.disconnect();
    state.observer = null;
    unmasonry(grid);
    state.grid = null;
    state.dispose = null;
  };
  return state.dispose;
}

/** Test-only reset hook. */
export function resetMasonry() {
  state.dispose?.();
  state.observer = null;
  state.grid = null;
}
