/**
 * Curated morph icon set.
 *
 * Path data is curated from **Lucide** (https://lucide.dev), ISC License,
 * © Lucide Contributors, 24×24 grid with a 2px stroke. A few compound shapes
 * (sun rays, monitor frame, pause bars) are flattened into a single `<path>`
 * so they can morph as one shape; geometry follows Lucide's originals.
 *
 * Filled variants are Lucide's outline path with a `fill` attribute — that is
 * what makes `morphicons` treat them as filled icons and morph stroke↔fill.
 *
 * Static, decorative icons keep using RemixIcon; this set is only for icons
 * that change state (theme sun/moon, play/pause, heart, menu/close, …).
 *
 * @module icons/data
 */

/** @typedef {ReadonlyArray<readonly [string, Record<string, string | number>]>} IconNode */

/** Lucide `sun`: circle + eight rays. */
const SUN =
  'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8';

/** Lucide `moon`. */
const MOON = 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z';

/** Lucide `monitor`. */
const MONITOR = 'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM8 21h8M12 17v4';

/** Lucide `sun-moon` (auto theme mode). */
const SUN_MOON =
  'M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41';

/** Lucide `menu`. */
const MENU = 'M4 6h16M4 12h16M4 18h16';

/** Lucide `x`. */
const X = 'M18 6 6 18M6 6l12 12';

/** Lucide `play`. */
const PLAY = 'M6 3l14 9-14 9V3Z';

/** Lucide `pause`. */
const PAUSE =
  'M7 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM15 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z';

/** Lucide `heart` (outline). */
const HEART =
  'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z';

/** Lucide `chevron-down`. */
const CHEVRON_DOWN = 'm6 9 6 6 6-6';

/** Lucide `chevron-up`. */
const CHEVRON_UP = 'm18 15-6-6-6 6';

/** Lucide `check`. */
const CHECK = 'M20 6 9 17l-5-5';

/** Lucide `volume-2`. */
const VOLUME_2 = 'M11 5 6 9H2v6h4l5 4V5ZM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14';

/** Lucide `volume-x`. */
const VOLUME_X = 'M11 5 6 9H2v6h4l5 4V5ZM22 9l-6 6M16 9l6 6';

/**
 * Icon definitions. Stroke icons are plain `d` strings; the filled heart is
 * an IconNode with a painted `fill` so morphicons can morph stroke ↔ fill.
 * @type {Readonly<Record<string, string | IconNode>>}
 */
export const ICONS = Object.freeze({
  sun: SUN,
  moon: MOON,
  monitor: MONITOR,
  sunMoon: SUN_MOON,
  menu: MENU,
  x: X,
  play: PLAY,
  pause: PAUSE,
  heart: HEART,
  heartFilled: Object.freeze([Object.freeze(['path', Object.freeze({ d: HEART, fill: 'currentColor' })])]),
  chevronDown: CHEVRON_DOWN,
  chevronUp: CHEVRON_UP,
  check: CHECK,
  volume2: VOLUME_2,
  volumeX: VOLUME_X,
});

/**
 * State pairs used by `setMorphIcon` callers. Kept here so every module
 * (theme menu, feed, playback) uses the same shapes.
 * @type {Readonly<Record<string, readonly [string, string]>>}
 */
export const MORPH_PAIRS = Object.freeze({
  theme: Object.freeze(['sun', 'moon']),
  menu: Object.freeze(['menu', 'x']),
  play: Object.freeze(['play', 'pause']),
  heart: Object.freeze(['heart', 'heartFilled']),
  volume: Object.freeze(['volume2', 'volumeX']),
  chevron: Object.freeze(['chevronDown', 'chevronUp']),
});

/** Icons that resolve from page state rather than a fixed name. */
export const STATE_ICONS = Object.freeze(['theme']);

/**
 * Resolve a state icon (`theme`) to a concrete icon name using the current
 * document theme; other names pass through.
 * @param {string} name
 * @returns {string}
 */
export function resolveIconName(name) {
  if (name === 'theme')
    return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'moon' : 'sun';
  return name;
}
