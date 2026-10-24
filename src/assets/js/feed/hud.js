/**
 * Feed HUD/transport layer: progress bar + seek, mute, pause indicator, like
 * rail (optimistic + localStorage + Worker API), share/comment actions, hint,
 * live-region announcements and toasts. `index.js` owns the overlay lifecycle
 * and slide state; `player.js` owns playback.
 */
import { updateHud } from './render.js';
import { postUrl, shareUrl } from './data.js';
import { spawnHearts, prefersReducedMotion } from './motion.js';
import { t, tf } from './strings.js';

const LIKES_KEY = 'mosaic_likes';

/** @returns {Set<string>} */
function readLikes() {
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
    /* private mode */
  }
}

/** @returns {string} */
function apiBase() {
  const meta = document.querySelector('meta[name="api-base"]')?.content;
  return (meta || window.__MOSAIC_CONFIG?.apiBase || '/api').replace(/\/+$/, '');
}

/**
 * @param {{
 *   getDialog: () => HTMLElement|null,
 *   getPlayer: () => object|null,
 *   getItems: () => Array<object>,
 *   getActive: () => number,
 *   announce: (text: string) => void,
 * }} deps
 */
export function createFeedHud({ getDialog, getPlayer, getItems, getActive, announce }) {
  let toastTimer = 0;
  let hintTimer = 0;
  let pauseTimer = 0;

  const dialog = () => getDialog();
  const activeItem = () => getItems()[getActive()];

  // ── toast / hint / pause visuals ────────────────────────────────────────
  /** @param {string} message */
  function toastMessage(message) {
    const el = dialog()?.querySelector('[data-feed-toast]');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2000);
  }

  function hideHint() {
    dialog()?.querySelector('[data-feed-hint]')?.classList.add('is-hidden');
  }

  function updateHint() {
    const hint = dialog()?.querySelector('[data-feed-hint]');
    if (!hint) return;
    hint.classList.remove('is-hidden');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 3200);
  }

  function showPauseIndicator() {
    const el = dialog()?.querySelector('[data-feed-pause]');
    if (!el) return;
    el.hidden = false;
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => {
      el.hidden = true;
    }, 700);
  }

  function hidePauseIndicator() {
    const el = dialog()?.querySelector('[data-feed-pause]');
    if (el) el.hidden = true;
  }

  // ── transport ───────────────────────────────────────────────────────────
  function togglePause() {
    const player = getPlayer();
    if (!player) return;
    if (player.isPaused()) {
      player.resume();
      hidePauseIndicator();
    } else {
      player.pause();
      showPauseIndicator();
    }
  }

  /** @param {boolean} muted */
  function setMutedUI(muted) {
    const button = dialog()?.querySelector('[data-feed-mute]');
    if (!button) return;
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.setAttribute('aria-label', muted ? t('unmute') : t('mute'));
    const icon = button.querySelector('i');
    if (icon) icon.className = muted ? 'ri-volume-mute-line' : 'ri-volume-up-line';
  }

  function toggleMute() {
    const player = getPlayer();
    if (!player) return;
    player.setMuted(!player.isMuted());
    setMutedUI(player.isMuted());
  }

  /**
   * @param {number} time
   * @param {number} duration
   */
  function setProgress(time, duration) {
    const bar = dialog()?.querySelector('[data-feed-progress]');
    const fill = dialog()?.querySelector('[data-feed-progress-fill]');
    if (!bar || !fill) return;
    const ratio = duration > 0 ? Math.max(0, Math.min(1, time / duration)) : 0;
    fill.style.width = `${ratio * 100}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  function bindProgress() {
    const bar = dialog()?.querySelector('[data-feed-progress]');
    if (!bar) return;
    const seek = (event) => {
      const rect = bar.getBoundingClientRect();
      getPlayer()?.seekRatio((event.clientX - rect.left) / Math.max(1, rect.width));
    };
    let dragging = false;
    bar.addEventListener('pointerdown', (event) => {
      dragging = true;
      bar.setPointerCapture?.(event.pointerId);
      seek(event);
    });
    bar.addEventListener('pointermove', (event) => {
      if (dragging) seek(event);
    });
    const end = () => {
      dragging = false;
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
    bar.addEventListener('keydown', (event) => {
      const player = getPlayer();
      if (!player || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      const controller = player.getController();
      const video = controller?.video || controller?.element;
      const item = activeItem();
      const duration = video?.duration || item?.duration || 0;
      if (!duration) return;
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 0.05 : -0.05;
      player.seekRatio(Math.max(0, Math.min(1, (video?.currentTime || 0) / duration + delta)));
    });
  }

  // ── likes / share / comments ────────────────────────────────────────────
  /** @param {number} index */
  function likeState(index) {
    const item = getItems()[index];
    if (!item) return { liked: false, likes: 0 };
    const liked = readLikes().has(item.slug);
    const base = Number(item.stats?.likes) || 0;
    return { liked, likes: base + (liked ? 1 : 0) };
  }

  /**
   * @param {number} [x] viewport coordinates of the double tap
   * @param {number} [y]
   */
  function likeActive(x, y) {
    const item = activeItem();
    const dialogEl = dialog();
    if (!item || !dialogEl) return;
    const set = readLikes();
    const wasLiked = set.has(item.slug);
    wasLiked ? set.delete(item.slug) : set.add(item.slug);
    writeLikes(set);
    updateHud(dialogEl, item, getActive(), getItems().length, likeState(getActive()));
    if (!wasLiked) {
      spawnHearts(dialogEl, x ?? window.innerWidth / 2, y ?? window.innerHeight / 2);
      const button = dialogEl.querySelector('[data-feed-like]');
      if (button && !prefersReducedMotion()) {
        button.classList.add('pop');
        setTimeout(() => button.classList.remove('pop'), 240);
      }
    }
    fetch(`${apiBase()}/track/like/${encodeURIComponent(item.slug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: wasLiked ? 'unlike' : 'like' }),
    }).catch(() => {});
  }

  async function shareActive() {
    const item = activeItem();
    if (!item) return;
    const url = shareUrl(item.slug);
    if (navigator.share) {
      try {
        await navigator.share({ title: item.title, text: item.description || '', url });
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toastMessage(t('copied'));
    } catch {
      toastMessage(url);
    }
  }

  /**
   * @param {MouseEvent} event
   * @returns {boolean} true when the click belonged to the HUD
   */
  function onClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.closest('[data-feed-mute]')) {
      toggleMute();
      return true;
    }
    if (target.closest('[data-feed-like]')) {
      const rect = target.closest('[data-feed-like]').getBoundingClientRect();
      likeActive(rect.left + rect.width / 2, rect.top);
      return true;
    }
    if (target.closest('[data-feed-share]')) {
      shareActive();
      return true;
    }
    if (target.closest('[data-feed-comment]')) {
      const item = activeItem();
      if (item) window.location.assign(postUrl(item.slug));
      return true;
    }
    return false;
  }

  /**
   * @param {string} event
   * @param {{index: number, payload: object}} data
   */
  function onPlayerEvent(event, { index, payload }) {
    if (index !== getActive()) return;
    if (event === 'timeupdate') {
      setProgress(payload?.time ?? 0, payload?.duration || activeItem()?.duration || 0);
    } else if (event === 'error') {
      toastMessage(t('loadFailed'));
    }
    // Quality downgrades are intentionally silent (like real feed apps); the
    // player already dropped to a lighter tier.
  }

  /** Refresh HUD/caption/rail for the active slide. */
  function syncActive() {
    const dialogEl = dialog();
    const player = getPlayer();
    if (!dialogEl) return;
    const index = getActive();
    const item = getItems()[index];
    if (!item) return;
    updateHud(dialogEl, item, index, getItems().length, likeState(index));
    setProgress(0, item.duration || 0);
    setMutedUI(player ? player.isMuted() : true);
    hidePauseIndicator();
    announce(tf('slideOf', index + 1, getItems().length));
  }

  function cleanup() {
    clearTimeout(toastTimer);
    clearTimeout(hintTimer);
    clearTimeout(pauseTimer);
  }

  return {
    bindProgress,
    hideHint,
    updateHint,
    togglePause,
    toggleMute,
    setMutedUI,
    likeActive,
    shareActive,
    onClick,
    onPlayerEvent,
    syncActive,
    toast: toastMessage,
    cleanup,
  };
}
