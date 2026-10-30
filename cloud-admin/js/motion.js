/**
 * Motion helpers — one place for route transitions and reduced-motion policy.
 *
 * The View Transitions API gives the page swap a real cross-fade without
 * shipping a client-side animation loop. Browsers without it keep the existing
 * CSS `pageIn` animation; reduced-motion users never see either.
 */

let active = false;

export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function supportsViewTransitions() {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function';
}

/**
 * Run a DOM update inside a view transition when that is safe.
 * Nested or unsupported calls run synchronously.
 * @param {() => void} update
 */
export function withViewTransition(update) {
  if (!supportsViewTransitions() || prefersReducedMotion() || active) {
    update();
    return;
  }
  active = true;
  try {
    const transition = document.startViewTransition(() => update());
    Promise.resolve(transition.finished)
      .catch(() => {})
      .finally(() => {
        active = false;
      });
  } catch {
    active = false;
    update();
  }
}
