/**
 * Note-modal social layer: likes (optimistic, localStorage + Worker API),
 * native share/clipboard with toast feedback, and the decorative heart burst.
 * Split from `interactions.js` to keep the media/carousel module small.
 */
import { formatCount } from './render.js';
import { shareUrl } from './data.js';
import { t } from './strings.js';
import { prefersReducedMotion } from './motion.js';

const LIKES_KEY = 'mosaic_likes';

/** @returns {string} Worker API base for likes (may be unavailable offline) */
function apiBase() {
  const meta = document.querySelector('meta[name="api-base"]')?.content;
  return (meta || window.__MOSAIC_CONFIG?.apiBase || '/api').replace(/\/+$/, '');
}

/** @returns {Set<string>} slugs liked by this browser (shared with likes.js) */
export function readLikes() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LIKES_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

/** @param {Set<string>} set */
function writeLikes(set) {
  try {
    localStorage.setItem(LIKES_KEY, JSON.stringify([...set]));
  } catch {
    /* private mode: in-memory only */
  }
}

/**
 * @param {{doc: Document, getHost: () => HTMLElement|null, getNote: () => object|null}} deps
 */
export function createNoteSocial({ doc, getHost, getNote }) {
  let toastTimer = 0;

  /** @param {string} message */
  function toast(message) {
    const el = getHost()?.querySelector('.note-toast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = message;
    el.hidden = false;
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2400);
  }

  /**
   * @param {HTMLElement} button
   * @param {number} count
   * @param {boolean} liked
   */
  function applyLike(button, count, liked) {
    if (!button) return;
    button.dataset.count = String(count);
    button.classList.toggle('liked', liked);
    button.setAttribute('aria-pressed', liked ? 'true' : 'false');
    button.setAttribute('aria-label', liked ? t('unlike') : t('like'));
    const icon = button.querySelector('i');
    if (icon) icon.className = liked ? 'ri-heart-fill' : 'ri-heart-line';
    getHost()
      ?.querySelectorAll('.note-like-count')
      .forEach((el) => (el.textContent = formatCount(count)));
  }

  /**
   * Decorative heart particles for the like interaction.
   * @param {MouseEvent} event
   * @param {HTMLElement} around
   */
  function burstHearts(event, around) {
    if (prefersReducedMotion()) return;
    const rect = around.getBoundingClientRect();
    const point = { x: event.clientX || rect.left + rect.width / 2, y: event.clientY || rect.top };
    for (let i = 0; i < 5; i += 1) {
      const heart = doc.createElement('span');
      heart.className = 'note-heart';
      heart.textContent = '♥';
      heart.style.left = `${point.x}px`;
      heart.style.top = `${point.y}px`;
      heart.style.setProperty('--dx', `${(Math.random() - 0.5) * 70}px`);
      heart.style.setProperty('--delay', `${i * 30}ms`);
      doc.body.appendChild(heart);
      setTimeout(() => heart.remove(), 900);
    }
  }

  /**
   * Optimistic like toggle. The card/post-page like button shares the same
   * localStorage key, so state stays consistent across surfaces.
   * @param {HTMLElement} button
   * @param {MouseEvent} event
   */
  function toggle(button, event) {
    const note = getNote();
    if (!note) return;
    const slug = note.slug;
    const set = readLikes();
    const wasLiked = set.has(slug);
    wasLiked ? set.delete(slug) : set.add(slug);
    writeLikes(set);
    const count = Math.max(0, Number(button.dataset.count || 0) + (wasLiked ? -1 : 1));
    applyLike(button, count, !wasLiked);
    if (!prefersReducedMotion()) {
      button.classList.add('pop');
      setTimeout(() => button.classList.remove('pop'), 240);
    }
    burstHearts(event, button);
    fetch(`${apiBase()}/track/like/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: wasLiked ? 'unlike' : 'like' }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data && typeof data.likes === 'number') applyLike(button, data.likes, !wasLiked);
      })
      .catch(() => {
        /* offline: localStorage is still the truth */
      });
  }

  /** @param {object} note */
  async function share(note) {
    const url = shareUrl(note.slug);
    const data = { title: note.title, text: note.description || '', url };
    if (navigator.share) {
      try {
        await navigator.share(data);
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast(t('shared'));
    } catch {
      toast(url);
    }
  }

  function cleanup() {
    clearTimeout(toastTimer);
  }

  return { toast, applyLike, toggle, share, cleanup };
}
