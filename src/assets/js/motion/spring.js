/**
 * A dependency-free spring integrator for DOM properties.
 *
 * One rAF loop drives a normalized spring (progress 0 -> 1) and maps the
 * progress onto CSS individual transform properties (`translate`, `scale`),
 * `opacity` and `filter: blur()`. Using the individual transform properties
 * (instead of `transform`) means spring motion composes with layout/centering
 * transforms already declared in CSS instead of clobbering them.
 *
 * The public entry point is {@link springTo}; `motion/index.js` re-exports it.
 *
 * @module motion/spring
 */
import { shouldAnimate, springPreset } from './presets.js';

/** Properties this integrator understands. @type {readonly string[]} */
const SPRING_PROPS = ['scale', 'opacity', 'x', 'y', 'blur'];

/** Resting defaults used when a property has no inline/computed value yet. */
const DEFAULTS = Object.freeze({ scale: 1, opacity: 1, x: 0, y: 0, blur: 0 });

/** At most one running spring per element; a new call supersedes the old one. */
const RUNNING = new WeakMap();

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Parse a CSS length/scale/filter string into the first number. */
function firstNumber(value, fallback) {
  if (typeof value !== 'string' || value === '' || value === 'none') return fallback;
  const match = /-?\d*\.?\d+/.exec(value);
  return match ? Number(match[0]) : fallback;
}

/** Parse the two components of `getComputedStyle(el).translate`. */
function parseTranslate(value) {
  if (!value || value === 'none') return { x: 0, y: 0 };
  const parts = value.split(/\s+/).map((part) => firstNumber(part, 0));
  return { x: parts[0] || 0, y: parts[1] || 0 };
}

/** Parse `blur(Npx)` out of a computed `filter` value. */
function parseBlur(value) {
  if (!value || value === 'none') return 0;
  const match = /blur\((-?\d*\.?\d+)px\)/.exec(value);
  return match ? Number(match[1]) : 0;
}

/**
 * Current animated properties of an element, inline values first and computed
 * values as the fallback (so springs start from whatever CSS currently shows).
 * @param {HTMLElement} el
 * @returns {{ scale: number, opacity: number, x: number, y: number, blur: number }}
 */
function readState(el) {
  const style = el.style;
  let computed = null;
  const computedOf = () => (computed ||= window.getComputedStyle(el));

  const translate = style.translate || computedOf().translate;
  const parsed = parseTranslate(translate);
  return {
    scale:
      style.scale !== '' ? firstNumber(style.scale, DEFAULTS.scale) : firstNumber(computedOf().scale, DEFAULTS.scale),
    opacity: style.opacity !== '' ? firstNumber(style.opacity, DEFAULTS.opacity) : firstNumber(computedOf().opacity, 1),
    x: parsed.x,
    y: parsed.y,
    blur: style.filter !== '' ? parseBlur(style.filter) : parseBlur(computedOf().filter),
  };
}

/**
 * Write a subset of animated properties. Absent keys are left untouched so a
 * scale-only spring never overrides a CSS-driven opacity, for example.
 * @param {HTMLElement} el
 * @param {Partial<{ scale: number, opacity: number, x: number, y: number, blur: number }>} state
 * @param {ReadonlySet<string>} keys properties this animation owns
 */
function writeState(el, state, keys) {
  if (keys.has('x') || keys.has('y')) {
    el.style.translate = `${(state.x ?? 0).toFixed(3)}px ${(state.y ?? 0).toFixed(3)}px`;
  }
  if (keys.has('scale')) el.style.scale = String(clamp(state.scale, 0, 8));
  if (keys.has('opacity')) el.style.opacity = String(clamp(state.opacity, 0, 1));
  if (keys.has('blur')) {
    // `filter: blur(0px)` would keep creating a containing block; clear it instead.
    const blur = state.blur ?? 0;
    if (blur > 0.01) el.style.filter = `blur(${blur.toFixed(3)}px)`;
    else if (el.style.filter) el.style.filter = '';
  }
}

/**
 * @typedef {Object} SpringToOptions
 * @property {'snappy'|'smooth'|'bouncy'|string} [preset] named preset (default `snappy`)
 * @property {number} [stiffness] override preset stiffness
 * @property {number} [damping] override preset damping
 * @property {boolean} [instant] jump to the target values without animating
 * @property {(frame: { progress: number, values: Record<string, number> }) => void} [onUpdate]
 *           Called on every frame with the eased progress and current values.
 */

/**
 * Animate an element towards `props` with real spring physics.
 *
 * - Props: `scale`, `opacity`, `x`, `y` (px), `blur` (px). Unspecified props
 *   are not touched.
 * - Always returns a Promise that **resolves** (never rejects). Calling it
 *   again for the same element cancels the previous spring, whose promise
 *   resolves early.
 * - Respects `prefers-reduced-motion` and `experience.motion.enabled` /
 *   `experience.motion.spring === 'none'`: the final values are applied
 *   instantly and the returned promise resolves on the next microtask.
 *
 * @param {HTMLElement} el
 * @param {Partial<{ scale: number, opacity: number, x: number, y: number, blur: number }>} props
 * @param {SpringToOptions} [options]
 * @returns {Promise<void>}
 */
export function springTo(el, props = {}, options = {}) {
  if (!el) return Promise.resolve();

  /** @type {Record<string, number>} */
  const target = {};
  for (const key of SPRING_PROPS) {
    const value = props[key];
    if (typeof value === 'number' && Number.isFinite(value)) target[key] = value;
  }
  const keys = new Set(Object.keys(target));
  if (keys.size === 0) return Promise.resolve();

  // A new spring supersedes the running one; it resolves early.
  const running = RUNNING.get(el);
  if (running) running.cancel();

  if (options.instant || !shouldAnimate()) {
    const state = { ...readState(el), ...target };
    writeState(el, state, keys);
    if (keys.has('blur') && !target.blur) el.style.filter = '';
    return Promise.resolve();
  }

  const preset = springPreset(options.preset);
  const stiffness = typeof options.stiffness === 'number' ? options.stiffness : preset.stiffness;
  const damping = typeof options.damping === 'number' ? options.damping : preset.damping;
  const from = readState(el);

  return new Promise((resolve) => {
    let progress = 0;
    let velocity = 0;
    let last = 0;
    let frame = 0;
    let done = false;

    const stop = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      el.style.willChange = '';
      RUNNING.delete(el);
      resolve();
    };

    const tick = (now) => {
      if (done) return;
      const dt = last === 0 ? 1 / 60 : clamp((now - last) / 1000, 0.001, 0.064);
      last = now;
      // Fixed micro-steps keep the integration stable on slow frames.
      const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      const h = dt / steps;
      for (let step = 0; step < steps; step++) {
        const accel = stiffness * (1 - progress) - damping * velocity;
        velocity += accel * h;
        progress += velocity * h;
      }
      progress = clamp(progress, -0.25, 1.25);
      const values = {};
      for (const key of keys) values[key] = from[key] + (target[key] - from[key]) * progress;
      writeState(el, values, keys);
      options.onUpdate?.({ progress, values });
      if (Math.abs(1 - progress) < 0.001 && Math.abs(velocity) < 0.02) {
        writeState(el, target, keys);
        if (keys.has('blur') && !target.blur) el.style.filter = '';
        stop();
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    RUNNING.set(el, { cancel: stop });
    el.style.willChange = 'translate, scale, opacity, filter';
    // Animate from progress 0 (velocity 0) towards progress 1.
    frame = requestAnimationFrame(tick);
  });
}

/**
 * Convenience helper for enter transitions: applies `from` instantly, then
 * springs to `to`. Resolves when settled (immediately under reduced motion).
 * @param {HTMLElement} el
 * @param {{ from?: Record<string, number>, to?: Record<string, number> } & SpringToOptions} [options]
 * @returns {Promise<void>}
 */
export function animateIn(el, options = {}) {
  if (!el) return Promise.resolve();
  const { from = { opacity: 0, y: 14 }, to = { opacity: 1, y: 0 }, ...springOptions } = options;
  if (options.instant || !shouldAnimate()) {
    return springTo(el, to, { ...springOptions, instant: true });
  }
  const fromKeys = new Set(Object.keys(from));
  writeState(el, from, fromKeys);
  return springTo(el, to, springOptions);
}

/**
 * Convenience helper for exit transitions. The caller decides when to hide
 * the element after the returned promise resolves.
 * @param {HTMLElement} el
 * @param {{ to?: Record<string, number> } & SpringToOptions} [options]
 * @returns {Promise<void>}
 */
export function animateOut(el, options = {}) {
  if (!el) return Promise.resolve();
  const { to = { opacity: 0, y: 8, scale: 0.98 }, ...springOptions } = options;
  return springTo(el, to, springOptions);
}

/** Cancel a running spring on `el` (if any), leaving it at its current frame. */
export function cancelSpring(el) {
  RUNNING.get(el)?.cancel();
}
