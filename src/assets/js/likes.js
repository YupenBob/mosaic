/**
 * Like button - localStorage backed
 */
import { $ } from './utils.js';

const STORAGE_KEY = 'mosaic_likes';

export function initLikes() {
  const btn = $('.like-button');
  if (!btn) return;

  const slug = btn.dataset.slug;
  const countEl = btn.querySelector('.like-count');
  if (!slug) return;

  // Read current state
  let likedSet = loadLikedSet();
  let count = parseInt(btn.dataset.count) || 0;
  const liked = likedSet.has(slug);

  // Update UI
  updateLikeButton(btn, count, liked, countEl);

  btn.addEventListener('click', () => {
    likedSet = loadLikedSet();
    const currentlyLiked = likedSet.has(slug);

    if (currentlyLiked) {
      likedSet.delete(slug);
      count = Math.max(0, count - 1);
    } else {
      likedSet.add(slug);
      count += 1;
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...likedSet]));
    } catch {
      // localStorage full or unavailable, silently ignore
    }

    updateLikeButton(btn, count, !currentlyLiked, countEl);
  });
}

function loadLikedSet() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function updateLikeButton(btn, count, liked, countEl) {
  btn.classList.toggle('liked', liked);
  btn.innerHTML = liked
    ? '<i class="ri-heart-fill"></i> <span class="like-count">' + count + '</span>'
    : '<i class="ri-heart-line"></i> <span class="like-count">' + count + '</span>';
}
