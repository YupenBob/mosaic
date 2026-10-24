/**
 * Progressive card-image upgrade (LQIP → real image).
 *
 * Server markup ships the few-KB preview as `src` and the real URL in
 * `data-src` / `data-srcset`; this module decodes the real image off-DOM and
 * swaps it in once ready. Goals:
 *  - no blank frames and no layout shift (the media box already has an
 *    aspect-ratio from the cover metadata);
 *  - the first two cover cards start the HD download immediately so LCP is not
 *    delayed by intersection waiting;
 *  - every other card only upgrades when it approaches the viewport;
 *  - data-saver visitors keep the LQIP.
 *
 * @module cards/media
 */
import { parseSrcset, pickCandidate, preloadImage, prefersReducedData } from '../utils/images.js';

/** How far before the viewport a card starts upgrading (px). */
const ROOT_MARGIN = '400px';

/** @type {{observer: IntersectionObserver|null, initialized: boolean}} */
const state = { observer: null, initialized: false };

/**
 * Target display width for one image in CSS px (device-pixel aware).
 * @param {HTMLImageElement} img
 * @returns {number}
 */
function targetWidth(img) {
  const dpr = Number(window.devicePixelRatio) || 1;
  const width = img.clientWidth || img.parentElement?.clientWidth || 0;
  return Math.max(320, Math.round((width || 320) * dpr));
}

/**
 * Upgrade one card image. Idempotent and safe if the node was replaced by a
 * re-render in the meantime.
 * @param {HTMLImageElement} img
 * @returns {Promise<boolean>} true when a real image was swapped in
 */
export async function upgradeCardImage(img) {
  if (!img || img.dataset.upgraded === 'true') return false;
  const fallback = img.getAttribute('data-src');
  if (!fallback) return false;
  if (prefersReducedData()) {
    // Data saver: keep the few-KB preview instead of fetching the HD image.
    img.dataset.upgraded = 'skipped';
    return false;
  }
  img.dataset.upgraded = 'pending';
  const candidates = parseSrcset(img.getAttribute('data-srcset') || '');
  const candidate = pickCandidate(candidates, targetWidth(img));
  const url = candidate ? candidate.url : fallback;
  const ok = await preloadImage(url, {
    fetchPriority: img.dataset.priority === 'true' ? 'high' : 'auto',
  });
  if (!ok || !img.isConnected) {
    if (!ok) img.dataset.upgraded = 'failed';
    return false;
  }
  // Keep srcset for future resizes, but pin the src we actually decoded so the
  // browser cannot re-fetch a second candidate synchronously.
  if (candidates.length) img.setAttribute('srcset', img.getAttribute('data-srcset'));
  img.src = url;
  img.classList.remove('is-lqip');
  img.classList.add('is-loaded', 'loaded');
  img.dataset.upgraded = 'true';
  img.removeAttribute('data-src');
  img.removeAttribute('data-srcset');
  return true;
}

/** @param {ParentNode} root */
function collectImages(root) {
  return Array.from(root.querySelectorAll?.('.post-card-img[data-src]') || []);
}

/** Lazily create the shared IntersectionObserver. */
function observer() {
  if (!state.observer && typeof IntersectionObserver === 'function') {
    state.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          state.observer.unobserve(entry.target);
          upgradeCardImage(entry.target);
        }
      },
      { rootMargin: ROOT_MARGIN },
    );
  }
  return state.observer;
}

/**
 * Upgrade priority images immediately and observe the rest.
 * Safe to call after every re-render (SSR grid, filter/search repaint).
 * @param {ParentNode} [root]
 */
export function upgradeCardMedia(root = document) {
  const images = collectImages(root);
  if (!images.length) return;
  const io = observer();
  for (const img of images) {
    if (img.dataset.upgraded) continue;
    if (img.dataset.priority === 'true' || !io) {
      upgradeCardImage(img);
      continue;
    }
    io.observe(img);
  }
}

/**
 * Initialize card-media upgrades for the page. Idempotent.
 * @param {ParentNode} [root]
 * @returns {() => void} dispose
 */
export function initCardMedia(root = document) {
  if (!state.initialized) state.initialized = true;
  upgradeCardMedia(root);
  if (typeof window !== 'undefined') {
    // New cards may be inserted outside the grid API (e.g. view-transition
    // snapshots); re-run once the page is idle to catch them.
    const schedule = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
    schedule(() => upgradeCardMedia(root));
  }
  return () => {
    state.observer?.disconnect();
    state.observer = null;
    state.initialized = false;
  };
}

/** Test-only reset hook (no side effects in production). */
export function resetCardMedia() {
  state.observer?.disconnect();
  state.observer = null;
  state.initialized = false;
}
