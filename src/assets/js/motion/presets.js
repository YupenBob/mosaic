/**
 * Spring presets and motion feature detection.
 *
 * Presets intentionally mirror the `morphicons` spring numbers so that card
 * motion, menu morphs and icon morphs share one physical feel. All values are
 * a normalized spring (progress 0 -> 1): stiffness `k`, damping `c`.
 *
 * @module motion/presets
 */

/** @typedef {{ stiffness: number, damping: number }} SpringConfig */

/** @type {Readonly<Record<string, SpringConfig>>} */
const PRESETS = Object.freeze({
  /** Critically damped, no overshoot. */
  smooth: Object.freeze({ stiffness: 170, damping: 26 }),
  /** Fast with a subtle overshoot (default). */
  snappy: Object.freeze({ stiffness: 420, damping: 30 }),
  /** Playful overshoot. */
  bouncy: Object.freeze({ stiffness: 300, damping: 14 }),
});

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * True when the visitor asked the OS/browser to reduce motion. Safe on the
 * server (no `window`) and when `matchMedia` is unavailable.
 * @returns {boolean}
 */
export function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(REDUCED_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Motion config injected by the SSG (`window.__MOSAIC_CONFIG.experience.motion`).
 * Missing config keeps the enhanced default (`{ enabled: true, spring: 'snappy' }`).
 * @returns {{ enabled: boolean, spring: string }}
 */
export function motionConfig() {
  const raw = typeof window === 'undefined' ? null : window.__MOSAIC_CONFIG?.experience?.motion;
  return {
    enabled: raw?.enabled !== false,
    spring: typeof raw?.spring === 'string' ? raw.spring : 'snappy',
  };
}

/**
 * Resolve a preset name to spring numbers.
 * @param {string} [name] preset name; unknown names fall back to `snappy`
 * @returns {SpringConfig} `{ stiffness, damping }`
 */
export function springPreset(name = 'snappy') {
  return PRESETS[name] || PRESETS.snappy;
}

/**
 * True when spring animation should be skipped entirely (either the visitor
 * prefers reduced motion or the site disabled motion in config).
 * @returns {boolean}
 */
export function shouldAnimate() {
  const { enabled, spring } = motionConfig();
  return enabled && spring !== 'none' && !prefersReducedMotion();
}

export { PRESETS };
