/**
 * Like button + view tracking — optimistic UI, server-synced
 */
import { $ } from './utils.js';

const LIKES_KEY = 'mosaic_likes';

export function initLikes({ apiBase = '/api' } = {}) {
  const btn = $('.like-button');
  if (!btn) return;
  const slug = btn.dataset.slug;
  if (!slug) return;

  const likedSet = loadLikedSet();
  let count = parseInt(btn.dataset.count) || 0;
  const liked = likedSet.has(slug);

  updateBtn(btn, count, liked);

  // Fire view tracking on page load (debounced: once per session per slug)
  trackView(apiBase, slug);

  btn.addEventListener('click', async () => {
    const set = loadLikedSet();
    const wasLiked = set.has(slug);
    const action = wasLiked ? 'unlike' : 'like';

    // Optimistic UI
    if (wasLiked) {
      set.delete(slug);
      count = Math.max(0, count - 1);
    } else {
      set.add(slug);
      count += 1;
    }
    saveLikedSet(set);
    updateBtn(btn, count, !wasLiked);

    // Sync to server
    try {
      const resp = await fetch(`${apiBase}/track/like/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (resp.ok) {
        const data = await resp.json();
        count = data.likes;
        updateBtn(btn, count, !wasLiked);
      }
    } catch {
      /* offline: localStorage is truth */
    }
  });
}

function trackView(apiBase, slug) {
  const key = `mosaic_viewed_${slug}`;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, '1');
  fetch(`${apiBase}/track/view/${encodeURIComponent(slug)}`, { method: 'POST' }).catch(() => {});
}

function loadLikedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(LIKES_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveLikedSet(set) {
  try {
    localStorage.setItem(LIKES_KEY, JSON.stringify([...set]));
  } catch {}
}

function updateBtn(btn, count, liked) {
  btn.classList.toggle('liked', liked);
  btn.innerHTML = (liked ? '<i class="ri-heart-fill"></i> ' : '<i class="ri-heart-line"></i> ') + count;
}
