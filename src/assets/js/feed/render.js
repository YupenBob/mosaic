/**
 * Markup for the full-screen vertical video feed. Render-only: index.js updates
 * the shared HUD/rail/caption elements as the active slide changes, player.js
 * mounts `<video>` elements lazily inside each slide.
 */
import { postUrl, primaryTag } from './data.js';
import { t, tf } from './strings.js';

/** @param {unknown} value @returns {string} */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * One full-viewport slide. Only the poster + text are rendered up front; the
 * `<video>` element is created by player.js when the slide enters the ±1 window.
 * @param {object} item
 * @param {number} index
 * @returns {string}
 */
export function slideHTML(item, index) {
  const poster = item.poster || item.cover || '';
  const bg = poster ? ` style="background-image:url('${escapeHtml(poster)}')"` : '';
  return `<section class="feed-slide" data-index="${index}" data-slug="${escapeHtml(item.slug)}" aria-label="${escapeHtml(
    item.title,
  )}">
    <div class="feed-slide-poster"${bg}>
      ${poster ? `<img src="${escapeHtml(poster)}" alt="" loading="${index <= 1 ? 'eager' : 'lazy'}" decoding="async" />` : ''}
    </div>
    <div class="feed-slide-media" data-media></div>
    <div class="feed-slide-shade" aria-hidden="true"></div>
  </section>`;
}

/**
 * Overlay shell with global HUD (top bar, right rail, caption, progress, hints).
 * @param {Array<object>} items
 * @returns {string}
 */
export function overlayHTML(items) {
  const slides = items.map((item, index) => slideHTML(item, index)).join('');
  return `<div class="feed-stage" data-feed-stage>
    <div class="feed-track" data-feed-track>${slides}</div>
  </div>
  <div class="feed-topbar">
    <button type="button" class="feed-icon-btn" data-feed-close aria-label="${escapeHtml(t('close'))}" data-autofocus>
      <i class="ri-close-line" aria-hidden="true"></i>
    </button>
    <div class="feed-topbar-right">
      <span class="feed-counter" data-feed-counter aria-hidden="true"></span>
      <button type="button" class="feed-icon-btn" data-feed-mute aria-label="${escapeHtml(t('mute'))}" aria-pressed="true">
        <i class="ri-volume-mute-line" aria-hidden="true"></i>
      </button>
    </div>
  </div>
  <div class="feed-rail">
    <a class="feed-rail-avatar" data-feed-post href="#" aria-label="${escapeHtml(t('openPost'))}">
      <i class="ri-user-3-line" aria-hidden="true"></i>
    </a>
    <button type="button" class="feed-rail-action" data-feed-like aria-pressed="false" aria-label="${escapeHtml(
      t('like'),
    )}">
      <i class="ri-heart-line" aria-hidden="true"></i><span data-feed-like-count>0</span>
    </button>
    <button type="button" class="feed-rail-action" data-feed-comment aria-label="${escapeHtml(t('comment'))}">
      <i class="ri-chat-3-line" aria-hidden="true"></i><span>${escapeHtml(t('comment'))}</span>
    </button>
    <button type="button" class="feed-rail-action" data-feed-share aria-label="${escapeHtml(t('share'))}">
      <i class="ri-share-forward-line" aria-hidden="true"></i><span>${escapeHtml(t('share'))}</span>
    </button>
  </div>
  <div class="feed-caption">
    <span class="feed-author" data-feed-author></span>
    <h2 class="feed-title" data-feed-title></h2>
    <p class="feed-desc" data-feed-desc></p>
    <div class="feed-tags" data-feed-tags></div>
  </div>
  <div class="feed-progress" data-feed-progress role="slider" tabindex="0" aria-label="${escapeHtml(
    t('progress'),
  )}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
    <span class="feed-progress-fill" data-feed-progress-fill></span>
  </div>
  <div class="feed-hint" data-feed-hint>${escapeHtml(t('swipeHint'))}</div>
  <div class="feed-pause-indicator" data-feed-pause hidden><i class="ri-play-fill" aria-hidden="true"></i></div>
  <div class="feed-toast" data-feed-toast role="status" aria-live="polite" hidden></div>
  <div class="sr-only" data-feed-live aria-live="polite"></div>`;
}

/**
 * Populate the shared HUD/caption/rail for the active item.
 * @param {HTMLElement} overlay
 * @param {object} item
 * @param {number} index
 * @param {number} total
 * @param {{liked: boolean, likes: number}} state
 */
export function updateHud(overlay, item, index, total, state) {
  const set = (selector, text) => {
    const el = overlay.querySelector(selector);
    if (el) el.textContent = text;
  };
  const author = primaryTag(item.tags) || item.category || '';
  set('[data-feed-author]', author ? `@${author}` : '');
  set('[data-feed-title]', item.title || '');
  set('[data-feed-desc]', item.description || '');
  set('[data-feed-counter]', `${index + 1}/${total}`);
  set('[data-feed-like-count]', formatCount(state.likes));
  const tags = overlay.querySelector('[data-feed-tags]');
  if (tags) {
    tags.innerHTML = (item.tags || [])
      .slice(0, 4)
      .map((tag) => `<span class="feed-tag">#${escapeHtml(tag)}</span>`)
      .join('');
  }
  const like = overlay.querySelector('[data-feed-like]');
  if (like) {
    like.classList.toggle('liked', state.liked);
    like.setAttribute('aria-pressed', state.liked ? 'true' : 'false');
    like.setAttribute('aria-label', state.liked ? t('unlike') : t('like'));
    const icon = like.querySelector('i');
    if (icon) icon.className = state.liked ? 'ri-heart-fill' : 'ri-heart-line';
  }
  const post = overlay.querySelector('[data-feed-post]');
  if (post) post.setAttribute('href', postUrl(item.slug));
  const counter = overlay.querySelector('[data-feed-counter]');
  if (counter) counter.title = tf('slideOf', index + 1, total);
}

/** @param {number} value */
export function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * @param {HTMLElement} overlay
 * @param {string} message
 */
export function toast(overlay, message) {
  const el = overlay.querySelector('[data-feed-toast]');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 2000);
}

/** Reset transient state before opening the feed again. @param {HTMLElement} overlay */
export function resetOverlay(overlay) {
  overlay.querySelector('[data-feed-toast]')?.setAttribute('hidden', '');
  overlay.querySelector('[data-feed-pause]')?.setAttribute('hidden', '');
  const hint = overlay.querySelector('[data-feed-hint]');
  if (hint) hint.classList.remove('is-hidden');
  overlay.querySelectorAll('.feed-slide').forEach((slide) => slide.classList.remove('is-playing', 'is-paused'));
}
