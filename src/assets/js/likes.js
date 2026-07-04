/**
 * Like button - localStorage only
 */
import { $ } from './utils.js';

const LIKES_KEY = 'mosaic_likes';

export function initLikes() {
  const btn = $('.like-button');
  if (!btn) return;
  const slug = btn.dataset.slug;
  if (!slug) return;

  let likedSet = (() => { try { return new Set(JSON.parse(localStorage.getItem(LIKES_KEY)||'[]')); } catch { return new Set(); } })();
  let count = parseInt(btn.dataset.count) || 0;
  const liked = likedSet.has(slug);

  updateBtn(btn, count, liked);

  btn.addEventListener('click', () => {
    likedSet = (() => { try { return new Set(JSON.parse(localStorage.getItem(LIKES_KEY)||'[]')); } catch { return new Set(); } })();
    if (likedSet.has(slug)) { likedSet.delete(slug); count = Math.max(0, count - 1); }
    else { likedSet.add(slug); count += 1; }
    try { localStorage.setItem(LIKES_KEY, JSON.stringify([...likedSet])); } catch {}
    updateBtn(btn, count, likedSet.has(slug));
  });
}

function updateBtn(btn, count, liked) {
  btn.classList.toggle('liked', liked);
  btn.innerHTML = (liked ? '<i class="ri-heart-fill"></i> ' : '<i class="ri-heart-line"></i> ') + count;
}
