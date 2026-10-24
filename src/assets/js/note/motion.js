/**
 * Motion adapter for the note modal.
 *
 * Prefers frontend-showcase's spring core (`src/assets/js/motion/index.js`,
 * contract §5). That module may land after this one, so the adapter lazy-imports
 * it and falls back to the Web Animations API — the modal never blocks on it and
 * behaves identically when the spring core is unavailable.
 *
 * The spring core animates CSS *individual properties* (`translate`, `scale`,
 * `opacity`), not `transform`, and applies the final values at rest. It handles
 * `prefers-reduced-motion` itself; the WAAPI fallback checks the media query.
 */
let modulePromise = null;

/** @returns {boolean} */
export function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** @returns {Promise<null|{springTo?: Function, animateIn?: Function, animateOut?: Function}>} */
function loadMotionModule() {
  if (!modulePromise) modulePromise = import('../motion/index.js').catch(() => null);
  return modulePromise;
}

/** Resolve after `promise` or after `ms` — a broken spring must never trap the UI. */
function withTimeout(promise, ms) {
  return Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);
}

/** Clear inline styles written by an animation so CSS classes own the rest state. */
function resetInline(el) {
  el.style.opacity = '';
  el.style.translate = '';
  el.style.scale = '';
  el.style.filter = '';
  el.style.transform = '';
}

/**
 * Web Animations fallback: translate/scale/opacity keyframes.
 * @param {HTMLElement} el
 * @param {Keyframe[]} frames
 * @param {number} duration
 * @returns {Promise<void>}
 */
function waapi(el, frames, duration) {
  if (!el.animate || prefersReducedMotion()) return Promise.resolve();
  const animation = el.animate(frames, {
    duration,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'both',
  });
  return animation.finished.then(() => animation.cancel()).catch(() => {});
}

/** @param {HTMLElement} el @param {{opacity?: number, scale?: number, y?: number}} state */
function applyState(el, state) {
  el.style.opacity = String(state.opacity ?? 1);
  el.style.scale = String(state.scale ?? 1);
  el.style.translate = `0 ${state.y ?? 0}px`;
}

/**
 * Spring the panel in.
 * @param {HTMLElement} el
 * @returns {Promise<void>}
 */
export async function enter(el) {
  const motion = await loadMotionModule();
  if (typeof motion?.animateIn === 'function') {
    await withTimeout(motion.animateIn(el), 700);
    resetInline(el);
    return;
  }
  if (typeof motion?.springTo === 'function') {
    try {
      applyState(el, { opacity: 0, scale: 0.96, y: 18 });
      await withTimeout(motion.springTo(el, { opacity: 1, scale: 1, y: 0 }), 700);
      resetInline(el);
      return;
    } catch {
      resetInline(el);
    }
  }
  await waapi(
    el,
    [
      { opacity: 0, transform: 'translate3d(0, 18px, 0) scale(0.96)' },
      { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
    ],
    240,
  );
}

/**
 * Spring the panel out; resolves once the exit visual is done (reduced motion
 * resolves immediately).
 * @param {HTMLElement} el
 * @returns {Promise<void>}
 */
export async function exit(el) {
  const motion = await loadMotionModule();
  if (typeof motion?.animateOut === 'function') {
    await withTimeout(motion.animateOut(el), 500);
    return;
  }
  if (typeof motion?.springTo === 'function') {
    try {
      await withTimeout(motion.springTo(el, { opacity: 0, scale: 0.98, y: 10 }), 400);
      return;
    } catch {
      /* fall through */
    }
  }
  await waapi(
    el,
    [
      { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
      { opacity: 0, transform: 'translate3d(0, 10px, 0) scale(0.98)' },
    ],
    180,
  );
}
