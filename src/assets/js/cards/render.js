/**
 * Single source of truth for list-card markup.
 *
 * Pure ESM with **zero DOM/Node dependencies**, so the exact same module
 * renders the server-side grid (`src/layouts/index.ejs` via a helper passed by
 * `scripts/site/render.mjs`) and client-side re-renders (`filter.js` /
 * `search.js`). Never duplicate card markup anywhere else.
 *
 * The markup is driven by CSS classes only (`card.css`), so visual variants
 * (`experience.card.size` / `image`) are handled entirely in CSS.
 *
 * @module cards/render
 */

/**
 * @typedef {Object} CardPostAspect
 * @property {string} [slug]
 * @property {string} [title]
 * @property {string} [description]
 * @property {string} [category]
 * @property {string[]} [tags]
 * @property {string} [cover]
 * @property {string} [coverLqip]
 * @property {number} [coverAspect]
 * @property {Record<string, string>|null} [coverSrcset]
 * @property {string} [date]
 * @property {string} [type]
 * @property {{ views?: number, likes?: number, dwell_time?: number }} [stats]
 */

/** Display aspect (width / height) range for masonry cards; keeps text legible. */
const ASPECT_MIN = 0.62;
const ASPECT_MAX = 1.5;
const ASPECT_FALLBACK = 4 / 3;

/**
 * Clamp the cover ratio for the masonry layout: each card keeps its own height
 * but extreme panoramas / super-tall covers are bounded.
 * @param {CardPostAspect} post
 * @returns {number}
 */
export function coverDisplayAspect(post) {
  const raw = Number(post && post.coverAspect);
  if (!Number.isFinite(raw) || raw <= 0) return ASPECT_FALLBACK;
  return Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, raw));
}

/** Escape text for HTML text nodes and attribute values. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Compact stat formatting (matches `utils.formatNumber`). */
function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** True for already-absolute media references (http(s), CDN, `/api/`, `/…`). */
function isAbsolute(value) {
  return /^(https?:\/\/|\/)/.test(value || '');
}

/**
 * Resolve a post-relative media reference to a URL.
 * @param {string} value e.g. `cover.jpg` or `photos/img-001.jpg`
 * @param {CardPostAspect} post
 * @param {string} base relative prefix to the site root (`''`, `'../'`, `'../../'`)
 */
function mediaUrl(value, post, base) {
  if (!value) return '';
  if (isAbsolute(value)) return value;
  return `${base}posts/${post.slug || ''}/${value}`;
}

/**
 * Build the `srcset` attribute from the generated cover variants.
 * @param {CardPostAspect} post
 * @param {string} base
 * @returns {string} `srcset` value or empty string
 */
function coverSrcset(post, base) {
  const variants = post.coverSrcset || {};
  return ['480', '720', '1080']
    .filter((width) => variants[width])
    .map((width) => `${mediaUrl(variants[width], post, base)} ${width}w`)
    .join(', ');
}

/**
 * Media layer markup.
 *
 * With a LQIP the initial `src` is the few-KB preview; the HD URL lives in
 * `data-src` / `data-srcset` and `cards/media.js` upgrades it after decoding.
 * Without a LQIP the HD image is the normal `src` (legacy/external covers).
 * A `<noscript>` fallback keeps cards complete when JavaScript is disabled.
 *
 * @param {CardPostAspect} post
 * @param {string} base
 * @param {boolean} priority
 * @returns {string}
 */
function mediaMarkup(post, base, priority) {
  const cover = mediaUrl(post.cover, post, base);
  const lqip = post.coverLqip ? mediaUrl(post.coverLqip, post, base) : '';
  const aspect = coverDisplayAspect(post);
  const srcset = post.coverSrcset ? coverSrcset(post, base) : '';
  const sizes = '(max-width: 639px) 100vw, (max-width: 1439px) 50vw, 33vw';
  const loadingAttrs = priority ? ' loading="eager" fetchpriority="high"' : ' loading="lazy"';
  const first = lqip || cover;
  return (
    `<div class="post-card-media" style="--cover-aspect:${aspect.toFixed(4)}">` +
    `<img class="post-card-img${lqip ? ' is-lqip' : ''}" src="${esc(first)}"` +
    (lqip ? ` data-src="${esc(cover)}"` : '') +
    (srcset ? ` ${lqip ? 'data-srcset' : 'srcset'}="${esc(srcset)}"` : '') +
    ` sizes="${sizes}" alt="${esc(post.title || '')}"${loadingAttrs}` +
    (priority ? ' data-priority="true"' : '') +
    ' decoding="async" />' +
    (lqip
      ? `<noscript><img class="post-card-img" src="${esc(cover)}"` +
        (srcset ? ` srcset="${esc(srcset)}"` : '') +
        ` sizes="${sizes}" alt="${esc(post.title || '')}"${loadingAttrs} /></noscript>`
      : '') +
    '</div>'
  );
}

/** View / dwell / likes row shared by every card. */
function statsHTML(post) {
  const stats = post.stats || {};
  return (
    '<span class="post-card-stat"><i class="ri-eye-line" aria-hidden="true"></i>' +
    `<span>${formatNumber(stats.views)}</span></span>` +
    '<span class="post-card-stat"><i class="ri-time-line" aria-hidden="true"></i>' +
    `<span>${formatNumber(stats.dwell_time)}s</span></span>` +
    '<span class="post-card-stat"><i class="ri-heart-line" aria-hidden="true"></i>' +
    `<span>${formatNumber(stats.likes)}</span></span>`
  );
}

/** Small optional type badge (decorative; the title/category carry meaning). */
function typeBadge(post) {
  if (post.type !== 'video') return '';
  return '<span class="post-card-badge" aria-hidden="true"><i class="ri-play-fill"></i></span>';
}

/**
 * Render one card.
 *
 * @param {CardPostAspect} post lite listing record (`data/posts-index.json`)
 * @param {{ base?: string, priority?: boolean }} [options]
 *        `base` is the server `rp` relative prefix (or the client-derived
 *        equivalent); `priority` marks above-the-fold cards for eager loading.
 * @returns {string} HTML for a single `<a class="post-card">`
 */
export function renderCard(post, options = {}) {
  if (!post || !post.slug) return '';
  const base = options.base || '';
  const title = post.title || post.slug;
  const category = post.category || '';
  const description = post.description || '';
  const tags = Array.isArray(post.tags) ? post.tags : [];
  const cover = post.cover ? mediaUrl(post.cover, post, base) : '';
  const isCover = Boolean(cover);

  const tagsHTML = tags.length
    ? '<div class="post-card-tags">' +
      tags.map((tag) => `<span class="post-card-tag">${esc(tag)}</span>`).join('') +
      '</div>'
    : '';

  const mediaHTML = isCover
    ? mediaMarkup(post, base, Boolean(options.priority))
    : '<div class="post-card-media" aria-hidden="true"></div>';

  return (
    `<a href="${esc(base)}posts/${esc(post.slug)}/" class="post-card ${isCover ? 'post-card--cover' : 'post-card--text'} motion-reveal"` +
    ` data-slug="${esc(post.slug)}" data-card-type="${isCover ? 'cover' : 'text'}"` +
    ' data-motion-reveal data-motion-press>' +
    mediaHTML +
    '<div class="post-card-scrim" aria-hidden="true"></div>' +
    typeBadge(post) +
    '<div class="post-card-body">' +
    (category ? `<span class="post-card-category">${esc(category)}</span>` : '') +
    `<h2 class="post-card-title">${esc(title)}</h2>` +
    (description ? `<p class="post-card-desc">${esc(description)}</p>` : '') +
    tagsHTML +
    `<div class="post-card-footer">${statsHTML(post)}</div>` +
    '</div></a>'
  );
}

/**
 * Render a whole grid's worth of cards.
 *
 * The first two *cover* cards are marked `priority` (eager + fetchpriority)
 * so the largest contentful paint is not delayed by lazy loading, regardless
 * of how many text-only cards appear first.
 *
 * @param {CardPostAspect[]} posts
 * @param {{ base?: string }} [options]
 * @returns {string}
 */
export function renderCards(posts, options = {}) {
  let priorityBudget = 2;
  return (posts || [])
    .map((post) => {
      const priority = Boolean(post && post.cover) && priorityBudget-- > 0;
      return renderCard(post, { ...options, priority });
    })
    .join('');
}

/**
 * Shared empty state (also used when a filter matches nothing).
 * @param {string} message already-translated, plain text
 * @returns {string}
 */
export function renderEmptyState(message) {
  return (
    '<div class="empty-state" data-motion-reveal>' +
    '<span class="empty-state-icon" aria-hidden="true"><i class="ri-inbox-line"></i></span>' +
    `<p>${esc(message)}</p>` +
    '</div>'
  );
}
