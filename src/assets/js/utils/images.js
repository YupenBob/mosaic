/**
 * Shared image-loading helpers used by the gallery and the card grid.
 *
 * Both surfaces follow the same progressive upgrade pattern: a tiny LQIP is
 * already visible, a larger candidate is decoded off-DOM, and only then swapped
 * in so the visitor never sees a blank frame or a layout jump.
 *
 * @module utils/images
 */

/**
 * Decode `src` off-DOM and, on success, assign it to `img.src`.
 * Resolves `false` on decode/network failure (the caller keeps the LQIP).
 * @param {HTMLImageElement} img
 * @param {string} src
 * @returns {Promise<boolean>}
 */
export function decodeThenSwap(img, src) {
  return new Promise((resolve) => {
    if (!src) {
      resolve(false);
      return;
    }
    const probe = new Image();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) img.src = src;
      resolve(ok);
    };
    probe.onload = () => done(true);
    probe.onerror = () => done(false);
    probe.src = src;
    if (probe.complete && probe.naturalWidth > 0) done(true);
  });
}

/**
 * Decode an image off-DOM without touching the DOM.
 * @param {string} src
 * @param {{ fetchPriority?: 'high'|'low'|'auto' }} [options]
 * @returns {Promise<boolean>}
 */
export function preloadImage(src, { fetchPriority = 'auto' } = {}) {
  return new Promise((resolve) => {
    if (!src) {
      resolve(false);
      return;
    }
    const probe = new Image();
    if (fetchPriority !== 'auto') {
      try {
        probe.fetchPriority = fetchPriority;
      } catch {
        /* unsupported */
      }
    }
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    probe.onload = () => done(true);
    probe.onerror = () => done(false);
    probe.src = src;
    if (probe.complete && probe.naturalWidth > 0) done(true);
  });
}

/**
 * Parse a `480w, 720w, 1080w` srcset into `{url,width}` candidates, ascending.
 * @param {string} srcset
 * @returns {Array<{url: string, width: number}>}
 */
export function parseSrcset(srcset) {
  if (!srcset) return [];
  return srcset
    .split(',')
    .map((entry) => entry.trim().split(/\s+/))
    .filter(([url, descriptor]) => url && /^\d+w$/.test(descriptor || ''))
    .map(([url, descriptor]) => ({ url, width: parseInt(descriptor, 10) }))
    .sort((a, b) => a.width - b.width);
}

/**
 * Pick the smallest candidate covering `targetWidth` (largest when none does).
 * @param {Array<{url: string, width: number}>} candidates
 * @param {number} targetWidth
 * @returns {{url: string, width: number}|null}
 */
export function pickCandidate(candidates, targetWidth) {
  if (!candidates.length) return null;
  return candidates.find((candidate) => candidate.width >= targetWidth) || candidates[candidates.length - 1];
}

/** True when the visitor asked to save data (network hints / media query). */
export function prefersReducedData() {
  try {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (connection?.saveData) return true;
  } catch {
    /* no connection API */
  }
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-data: reduce)').matches);
  } catch {
    return false;
  }
}
