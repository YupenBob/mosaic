/**
 * Mosaic motion core — public entry point.
 *
 * One spring language for the whole frontend: cards, menus, empty states and
 * (via the same exports) the note modal / vertical feed built by other
 * modules. No animation library: a small rAF spring integrator lives in
 * `spring.js`; CSS hooks live in `assets/css/motion.css`.
 *
 * Contract (docs/experience-v2-plan.md §5):
 *   initMotion(root = document)  -> dispose
 *   springTo(el, props, options) -> Promise
 *   springPreset(name)           -> { stiffness, damping }
 *
 * All entry points respect `prefers-reduced-motion` and
 * `window.__MOSAIC_CONFIG.experience.motion`.
 *
 * @module motion
 */
import { prefersReducedMotion, motionConfig, springPreset } from './presets.js';
import { springTo, animateIn, animateOut, cancelSpring } from './spring.js';
import { initReveal, initPress } from './behaviors.js';

/**
 * Immediately reveal any `[data-motion-reveal]` element in `root` that is not
 * revealed yet. Used after client-side re-renders (filter/search) so cards
 * inserted after `initMotion()` can never stay stuck invisible.
 * @param {ParentNode} [root]
 */
export function revealAll(root = document) {
  root.querySelectorAll?.('[data-motion-reveal]:not(.is-revealed)').forEach((el) => {
    el.classList.add('is-revealed');
  });
}

/**
 * Initialize page motion. Idempotent: the root element records that motion
 * was initialized and a second call is a no-op returning a harmless dispose.
 *
 * Sets `data-motion="on"` on `<html>` only when animation should run (this is
 * what unlocks the CSS reveal states); otherwise everything is shown plainly.
 *
 * @param {ParentNode} [root] defaults to `document`
 * @returns {() => void} dispose function — restores listeners/observer
 */
export function initMotion(root = document) {
  const docEl = typeof document === 'undefined' ? null : document.documentElement;
  if (!docEl || docEl.dataset.motionReady === 'true') return () => {};

  const animate = motionConfig().enabled && !prefersReducedMotion();
  docEl.dataset.motion = animate ? 'on' : 'off';
  docEl.dataset.motionReady = 'true';

  const disposers = [];
  try {
    disposers.push(initReveal(root));
    disposers.push(initPress(root));
  } catch (error) {
    // Motion is an enhancement: never let it break the page.
    console.warn('[motion] init failed:', error);
    docEl.dataset.motion = 'off';
  }

  return () => {
    disposers.forEach((dispose) => {
      try {
        dispose();
      } catch {
        /* noop */
      }
    });
    delete docEl.dataset.motionReady;
    docEl.dataset.motion = 'off';
  };
}

/**
 * Run `update` inside a View Transition when the browser supports it and
 * motion is allowed. Progressive enhancement only: callers must keep the
 * base behavior working when this resolves immediately.
 *
 * @param {() => void | Promise<void>} update
 * @returns {Promise<void>}
 */
export function withViewTransition(update) {
  if (
    typeof document === 'undefined' ||
    typeof document.startViewTransition !== 'function' ||
    !motionConfig().enabled
  ) {
    return Promise.resolve(update()).then(() => {});
  }
  if (prefersReducedMotion()) return Promise.resolve(update()).then(() => {});
  try {
    return document.startViewTransition(update).finished.then(() => {});
  } catch {
    return Promise.resolve(update()).then(() => {});
  }
}

export { springTo, springPreset, prefersReducedMotion, animateIn, animateOut, cancelSpring };
