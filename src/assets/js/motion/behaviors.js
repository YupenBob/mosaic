/**
 * Motion behaviors wired onto server-rendered / client-rendered markup:
 * scroll reveal for cards, press feedback and empty-state entrance.
 *
 * Elements opt in with `data-motion-reveal` (reveal) or `data-motion-press`
 * (press) attributes — see `cards/render.js` and the list page template.
 *
 * @module motion/behaviors
 */
import { shouldAnimate, prefersReducedMotion } from './presets.js';
import { springTo, animateIn } from './spring.js';

/** @type {WeakSet<Element>} elements already revealed (idempotency guard) */
const revealed = new WeakSet();

/** Root margin keeps reveals slightly before the fold so they feel early. */
const REVEAL_MARGIN = '0px 0px -6% 0px';

/**
 * Reveal elements on first viewport intersection with a small stagger.
 * Under reduced motion (or motion disabled) everything is marked revealed
 * immediately so nothing can stay hidden.
 * @param {ParentNode} root
 * @returns {() => void} cleanup
 */
export function initReveal(root) {
  const targets = Array.from(root.querySelectorAll('[data-motion-reveal]')).filter(
    (el) => !revealed.has(el) && !el.classList.contains('is-revealed'),
  );
  if (targets.length === 0) return () => {};

  const show = (el) => {
    if (revealed.has(el)) return;
    revealed.add(el);
    el.classList.add('is-revealed');
  };

  if (!shouldAnimate()) {
    targets.forEach(show);
    return () => {};
  }

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.time - b.time);
      visible.forEach((entry, index) => {
        const el = entry.target;
        // Stagger per batch (column rows) but never delay more than ~180ms.
        el.style.transitionDelay = `${Math.min(index * 45, 180)}ms`;
        show(el);
        observer.unobserve(el);
      });
    },
    { rootMargin: REVEAL_MARGIN, threshold: 0.05 },
  );
  targets.forEach((el) => observer.observe(el));
  return () => observer.disconnect();
}

/**
 * Spring press feedback for cards and other pressable surfaces. Purely
 * visual: no click interception, no `preventDefault`, navigation untouched.
 * @param {ParentNode} root
 * @returns {() => void} cleanup
 */
export function initPress(root) {
  if (!shouldAnimate()) return () => {};

  /** @type {Map<Element, number>} element -> pointerId of the active press */
  const pressed = new Map();

  const findTarget = (node) => (node instanceof Element ? node.closest('[data-motion-press]') : null);

  const release = (el) => {
    if (!el || !pressed.has(el)) return;
    pressed.delete(el);
    if (!el.isConnected) return;
    springTo(el, { scale: 1 }, { preset: 'snappy' });
  };

  /** Release every element held by a given pointer (idempotent). */
  const releasePointer = (pointerId) => {
    if (pointerId == null) return;
    for (const [el, id] of pressed) if (id === pointerId) release(el);
  };

  const onPointerDown = (event) => {
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    const el = findTarget(event.target);
    if (!el || pressed.has(el)) return;
    pressed.set(el, event.pointerId);
    springTo(el, { scale: 0.985 }, { preset: 'snappy' });
  };
  const onPointerUp = (event) => {
    const el = findTarget(event.target);
    if (el) release(el);
    // Also release when the pointer moved outside the card before lifting.
    releasePointer(event.pointerId);
  };
  const onPointerCancel = (event) => {
    releasePointer(event.pointerId);
  };

  const node = root instanceof Document ? root : document;
  node.addEventListener('pointerdown', onPointerDown, { passive: true });
  node.addEventListener('pointerup', onPointerUp, { passive: true });
  node.addEventListener('pointercancel', onPointerCancel, { passive: true });
  return () => {
    pressed.forEach((_, el) => release(el));
    node.removeEventListener('pointerdown', onPointerDown);
    node.removeEventListener('pointerup', onPointerUp);
    node.removeEventListener('pointercancel', onPointerCancel);
  };
}

/**
 * Fade/slide the empty state in after a filter change so results do not
 * "pop". Reduced motion resolves immediately.
 * @param {Element|null} emptyState
 * @returns {Promise<void>}
 */
export function animateEmptyState(emptyState) {
  if (!(emptyState instanceof HTMLElement)) return Promise.resolve();
  return animateIn(emptyState, { from: { opacity: 0, y: 8 }, to: { opacity: 1, y: 0 }, preset: 'smooth' });
}

/** True when the visitor/OS wants reduced motion — re-exported for callers. */
export { prefersReducedMotion };
