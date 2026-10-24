/**
 * Morph state icons — inline SVG hydration on top of `morphicons`.
 *
 * Templates render a cheap RemixIcon fallback inside `[data-morph-icon]`;
 * `initIcons()` swaps it for an inline `<svg>` whose `<path>` is driven by
 * `createMorph`, so state changes (sun↔moon, play↔pause, heart↔filled,
 * menu↔close, …) morph with spring physics. Static decorative icons keep
 * using RemixIcon.
 *
 * Contract (docs/experience-v2-plan.md §5):
 *   initIcons(root = document)              -> dispose
 *   setMorphIcon(el, iconName, options)     -> Morph | null
 *   iconElement(iconName, options)          -> SVGSVGElement | null
 *
 * @module icons
 */
import { createMorph } from 'morphicons/dom';
import { ICONS, MORPH_PAIRS, resolveIconName } from './data.js';
import { prefersReducedMotion, motionConfig } from '../motion/presets.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_SPRING = 'snappy';

/** @type {WeakMap<SVGSVGElement, { morph: ReturnType<typeof createMorph>, path: SVGPathElement, iconName: string }>} */
const REGISTRY = new WeakMap();

/** @type {Set<string>} warnings de-duplicated per page */
const warned = new Set();

/** Current spring name from site config, mapped to morphicons presets. */
function springName() {
  const { spring } = motionConfig();
  return spring === 'smooth' || spring === 'bouncy' || spring === 'snappy' ? spring : DEFAULT_SPRING;
}

/** Morphicons reduced-motion policy: follow the visitor's OS setting. */
function reducedPolicy() {
  return prefersReducedMotion() ? 'user' : 'user';
}

/**
 * Create an inline SVG icon (morph-enabled when the DOM supports it).
 *
 * @param {string} iconName name from `icons/data.js` (`sun`, `play`, …) or the
 *        state alias `theme` (resolved from the current theme)
 * @param {{ className?: string, label?: string, strokeWidth?: number, size?: number }} [options]
 * @returns {SVGSVGElement|null}
 */
export function iconElement(iconName, options = {}) {
  if (typeof document === 'undefined') return null;
  const name = resolveIconName(String(iconName || ''));
  const icon = ICONS[name];
  if (!icon) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[icons] unknown icon "${name}"`);
    }
    return null;
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(options.strokeWidth || 2));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', options.className ? `morph-icon ${options.className}` : 'morph-icon');
  svg.setAttribute('data-icon', name);
  if (options.size) {
    svg.setAttribute('width', String(options.size));
    svg.setAttribute('height', String(options.size));
  }
  if (options.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const path = document.createElementNS(SVG_NS, 'path');
  svg.append(path);
  const morph = createMorph(path, icon, { reducedMotion: reducedPolicy(), strokeWidth: options.strokeWidth || 2 });
  REGISTRY.set(svg, { morph, path, iconName: name });
  return svg;
}

/**
 * Find (or lazily hydrate) the SVG for a wrapper/element.
 * @param {Element} el `[data-morph-icon]` wrapper or an `svg.morph-icon`
 * @param {string} [fallbackName]
 * @returns {SVGSVGElement|null}
 */
function ensureSvg(el, fallbackName) {
  if (!el) return null;
  if (el instanceof SVGSVGElement) return el;
  const existing = el.querySelector('svg.morph-icon');
  if (existing) return existing;
  const name = fallbackName || el.getAttribute('data-morph-icon') || 'sun';
  const svg = iconElement(name);
  if (!svg) return null;
  el.replaceChildren(svg);
  if (el instanceof HTMLElement) {
    el.classList.add('morph-icon-slot');
    el.dataset.morphReady = 'true';
  }
  return svg;
}

/**
 * Morph an already-hydrated icon element to another state.
 *
 * @param {Element} el `[data-morph-icon]` wrapper or the svg itself
 * @param {string} iconName target icon name (or state alias `theme`)
 * @param {{ from?: string, spring?: string }} [options] `from` first snaps the
 *        icon to that state, which is then morphed to `iconName` (used for
 *        explicit state pairs).
 * @returns {ReturnType<typeof createMorph>|null} morph driver, or null
 */
export function setMorphIcon(el, iconName, options = {}) {
  const svg = ensureSvg(el, typeof options.from === 'string' ? options.from : undefined);
  if (!svg) return null;
  const entry = REGISTRY.get(svg);
  if (!entry) return null;
  const name = resolveIconName(String(iconName || ''));
  const icon = ICONS[name];
  if (!icon) return null;
  const spring = options.spring || springName();
  if (typeof options.from === 'string' && ICONS[options.from]) entry.morph.set(ICONS[options.from]);
  entry.morph.morphTo(icon, spring);
  entry.iconName = name;
  svg.setAttribute('data-icon', name);
  return entry.morph;
}

/**
 * Hydrate every `[data-morph-icon]` in the tree and keep `theme` icons in sync
 * with theme changes (`mosaic:theme` event dispatched by `theme.js`).
 *
 * @param {ParentNode} [root]
 * @returns {() => void} dispose
 */
export function initIcons(root = document) {
  if (typeof document === 'undefined') return () => {};
  if (motionConfig().enabled === false) return () => {};
  const config = typeof window === 'undefined' ? null : window.__MOSAIC_CONFIG?.experience?.morphIcons;
  if (config?.enabled === false) return () => {};

  const hydrate = (wrapper) => {
    if (!(wrapper instanceof HTMLElement) || wrapper.dataset.morphReady === 'true') return;
    const svg = ensureSvg(wrapper);
    if (svg) wrapper.dataset.morphReady = 'true';
  };

  const hydrateTree = (node) => {
    if (node instanceof Element && node.matches('[data-morph-icon]')) hydrate(node);
    node.querySelectorAll?.('[data-morph-icon]').forEach(hydrate);
  };

  hydrateTree(root instanceof Document ? root.documentElement : root);

  const onTheme = (event) => {
    const resolved = event?.detail?.resolved;
    const dark = resolved ? resolved === 'dark' : document.documentElement.dataset.theme === 'dark';
    root
      .querySelectorAll?.('[data-morph-icon="theme"]')
      .forEach((wrapper) => setMorphIcon(wrapper, dark ? 'moon' : 'sun'));
  };
  document.addEventListener('mosaic:theme', onTheme);

  // Expose a tiny global for modules that cannot import this one directly.
  window.MosaicIcons = Object.freeze({ initIcons, setMorphIcon, iconElement, MORPH_PAIRS, ICONS });

  return () => {
    document.removeEventListener('mosaic:theme', onTheme);
    root.querySelectorAll?.('[data-morph-icon]').forEach((wrapper) => {
      if (wrapper instanceof HTMLElement) delete wrapper.dataset.morphReady;
    });
  };
}

export { ICONS, MORPH_PAIRS };
