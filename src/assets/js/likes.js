/**
 * Like button — localStorage backed with Worker API sync
 */
import { $ } from './utils.js';

const STORAGE_KEY = 'mosaic_likes';
let API_BASE = '';

export function initLikes(config) {
  const btn = $('.like-button');
  if (!btn) return;

  API_BASE = config?.apiBase || '';
  const slug = btn.dataset.slug;
  const countEl = btn.querySelector('.like-count');
  if (!slug) return;

  let likedSet = loadLikedSet();
  let count = parseInt(btn.dataset.count) || 0;
  const liked = likedSet.has(slug);

  // Fetch real count from API
  if (API_BASE) {
    fetch(`${API_BASE}/like/${encodeURIComponent(slug)}/count`)
      .then(r => r.json())
      .then(d => { if (d.count !== undefined) { count = d.count; updateLikeButton(btn, count, liked, countEl); } })
      .catch(() => {});
  }

  updateLikeButton(btn, count, liked, countEl);

  btn.addEventListener('click', async () => {
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
    } catch {}

    // Sync to API
    if (API_BASE) {
      try {
        const r = await fetch(`${API_BASE}/like/${encodeURIComponent(slug)}`, { method: 'POST' });
        const d = await r.json();
        count = d.count;
      } catch {}
    }

    updateLikeButton(btn, count, !currentlyLiked, countEl);
  });
}

function loadLikedSet() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

function updateLikeButton(btn, count, liked, countEl) {
  btn.classList.toggle('liked', liked);
  btn.innerHTML = liked
    ? '<i class="ri-heart-fill"></i> <span class="like-count">' + count + '</span>'
    : '<i class="ri-heart-line"></i> <span class="like-count">' + count + '</span>';
}
