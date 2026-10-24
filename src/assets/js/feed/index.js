/**
 * Douyin-style vertical video feed: floating entry button (no template edits) →
 * full-screen scroll-snap overlay with wheel/touch/keyboard navigation, exactly
 * one playing video, ±1 preload, tap pause, double-tap like, right-side rail,
 * progress bar, mute toggle, swipe-down close and reduced-motion support.
 *
 * `initVerticalFeed()` is idempotent and returns `{ open(index?), close(),
 * dispose(), isOpen() }`. This module owns the overlay lifecycle + slide state;
 * playback is delegated to playback-quality via `player.js`, and the HUD/rail
 * transport lives in `hud.js`.
 */
import { loadFeed } from './data.js';
import { overlayHTML, resetOverlay } from './render.js';
import { createFeedHud } from './hud.js';
import { createGestures } from './gestures.js';
import { FeedPlayer } from './player.js';
import { prefersReducedMotion } from './motion.js';
import { t } from './strings.js';

let instance = null;

/**
 * Initialize the vertical feed (list pages only; no-op when disabled).
 * @param {{enabled?: boolean}} [options]
 * @returns {{open: (index?: number) => void, close: () => void, dispose: () => void, isOpen: () => boolean}}
 */
export function initVerticalFeed(options = {}) {
  if (instance) return instance;
  instance = createVerticalFeed(options);
  return instance;
}

/** @returns {boolean} feature flag, default on when the config key is absent */
function configEnabled() {
  return window.__MOSAIC_CONFIG?.experience?.verticalFeed?.enabled !== false;
}

/** Keep the page behind the full-screen layer from scrolling. @returns {() => void} */
function lockPageScroll() {
  const y = window.scrollY;
  const root = document.documentElement;
  const body = document.body;
  const previous = { root: root.style.overflow, body: body.style.overflow };
  root.classList.add('overlay-scroll-locked');
  root.style.overflow = 'hidden';
  body.style.overflow = 'hidden';
  return () => {
    root.classList.remove('overlay-scroll-locked');
    root.style.overflow = previous.root;
    body.style.overflow = previous.body;
    window.scrollTo(0, y);
  };
}

/**
 * @param {{enabled?: boolean}} options
 * @returns {{open: Function, close: Function, dispose: Function, isOpen: Function}}
 */
function createVerticalFeed(options) {
  const enabled = options.enabled ?? configEnabled();
  if (!enabled || (document.body?.dataset.page || 'list') !== 'list') {
    return { open() {}, close() {}, dispose() {}, isOpen: () => false };
  }

  let dialog = null;
  let stage = null;
  let track = null;
  let player = null;
  let gestures = null;
  let hud = null;
  let entry = null;
  let sessionAbort = null;
  let releaseScroll = null;
  let items = [];
  let active = 0;
  let isOpen = false;
  let disposed = false;
  let openRequest = 0;
  let resizeTimer = 0;

  // ── entry button (injected, no template edits) ──────────────────────────
  function injectEntry() {
    if (entry || disposed) return;
    entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'feed-entry-btn';
    entry.setAttribute('aria-label', t('entryLabel'));
    entry.setAttribute('aria-haspopup', 'dialog');
    entry.innerHTML = `<i class="ri-play-circle-line" aria-hidden="true"></i><span>${t('entry')}</span>`;
    entry.addEventListener('click', () => openFeed(0));
    document.body.appendChild(entry);
  }

  function scheduleEntry() {
    const run = () => {
      loadFeed()
        .then((list) => {
          if (!disposed && list.length) injectEntry();
        })
        .catch(() => {});
    };
    if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 1500 });
    else window.setTimeout(run, 600);
  }

  // ── overlay shell ───────────────────────────────────────────────────────
  function buildDialog() {
    dialog = document.createElement('dialog');
    dialog.className = 'feed-overlay';
    dialog.setAttribute('aria-label', t('dialogLabel'));
    dialog.innerHTML = overlayHTML(items);
    document.body.appendChild(dialog);
    stage = dialog.querySelector('[data-feed-stage]');
    track = dialog.querySelector('[data-feed-track]');
    sessionAbort = new AbortController();
    const { signal } = sessionAbort;
    dialog.addEventListener('click', onClick, { signal });
    dialog.addEventListener('keydown', onKeydown, { signal });
    dialog.addEventListener(
      'cancel',
      (event) => {
        event.preventDefault();
        close();
      },
      { signal },
    );
    hud = createFeedHud({
      getDialog: () => dialog,
      getPlayer: () => player,
      getItems: () => items,
      getActive: () => active,
      announce,
    });
    hud.bindProgress();
    gestures = createGestures({
      stage,
      getIndex: () => active,
      getCount: () => items.length,
      onDragStart: () => {
        track.classList.add('is-dragging');
        hud.hideHint();
      },
      onDrag: (offset) => {
        const height = stage?.clientHeight || window.innerHeight;
        track.style.transform = `translate3d(0, ${-active * height + offset}px, 0)`;
        // Prewarm the neighbour in the swipe direction once the drag intends it.
        if (Math.abs(offset) > 24) player?.intent(offset < 0 ? 1 : -1);
      },
      onDragEnd: () => track.classList.remove('is-dragging'),
      onNavigate: (direction) => navigate(direction),
      onClose: () => close(),
      onTap: () => hud.togglePause(),
      onDoubleTap: (x, y) => hud.likeActive(x, y),
    });
    window.addEventListener('resize', onResize, { signal });
  }

  // ── slide state ─────────────────────────────────────────────────────────
  /** @param {number} index @param {{instant?: boolean}} [opts] */
  function goTo(index, opts = {}) {
    active = Math.max(0, Math.min(items.length - 1, index));
    const height = stage?.clientHeight || window.innerHeight;
    const instant = opts.instant || prefersReducedMotion();
    if (instant) track.classList.add('no-anim');
    track.style.transform = `translate3d(0, ${-active * height}px, 0)`;
    if (instant) requestAnimationFrame(() => track?.classList.remove('no-anim'));
    dialog.querySelectorAll('.feed-slide').forEach((slide) => {
      slide.classList.toggle('is-active', Number(slide.dataset.index) === active);
    });
    dialog.dataset.active = String(active);
    hud.syncActive();
    player?.activate(active).catch(() => {});
  }

  /** @param {1|-1} direction */
  function navigate(direction) {
    if (!isOpen) return;
    const next = active + direction;
    if (next < 0 || next >= items.length) {
      hud.toast(t('endOfFeed'));
      return;
    }
    hud.hideHint();
    player?.intent(direction); // intent-gated prewarm of the target neighbour
    goTo(next);
  }

  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (isOpen && track) goTo(active, { instant: true });
    }, 120);
  }

  /** @param {string} text */
  function announce(text) {
    const live = dialog?.querySelector('[data-feed-live]');
    if (live) live.textContent = text;
  }

  // ── events ──────────────────────────────────────────────────────────────
  /** @param {MouseEvent} event */
  function onClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.closest('[data-feed-close]')) {
      close();
      return;
    }
    hud.onClick(event);
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (!isOpen) return;
    if (event.target.closest?.('[data-feed-progress]')) return; // handled by the progress bar
    if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      navigate(1);
    } else if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      navigate(-1);
    } else if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      hud.togglePause();
    } else if (event.key === 'm' || event.key === 'M') {
      hud.toggleMute();
    }
  }

  // ── open / close ────────────────────────────────────────────────────────
  /** @param {number} [index] */
  async function openFeed(index = 0) {
    if (isOpen || disposed) return;
    const token = ++openRequest;
    let list;
    try {
      list = await loadFeed();
    } catch {
      return;
    }
    if (token !== openRequest || disposed || !list.length) return;
    items = list;
    buildDialog();
    resetOverlay(dialog);
    dialog.showModal();
    isOpen = true;
    document.documentElement.classList.add('feed-open');
    releaseScroll = lockPageScroll();
    player = new FeedPlayer({
      overlay: dialog,
      onEvent: (event, data) => hud.onPlayerEvent(event, data),
    });
    player.setItems(items);
    hud.syncActive();
    goTo(Math.max(0, Math.min(items.length - 1, index)), { instant: true });
    hud.updateHint();
    dialog.querySelector('[data-feed-close]')?.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    openRequest += 1;
    clearTimeout(resizeTimer);
    hud?.cleanup();
    hud = null;
    gestures?.dispose();
    gestures = null;
    sessionAbort?.abort();
    sessionAbort = null;
    player?.destroy();
    player = null;
    releaseScroll?.();
    releaseScroll = null;
    document.documentElement.classList.remove('feed-open');
    try {
      dialog?.close();
    } catch {
      /* already closed */
    }
    dialog?.remove();
    dialog = null;
    stage = null;
    track = null;
    items = [];
    active = 0;
    try {
      entry?.focus?.({ preventScroll: true });
    } catch {
      /* entry may be gone */
    }
  }

  function dispose() {
    disposed = true;
    close();
    entry?.remove();
    entry = null;
    window.setTimeout(() => {
      if (instance === controller) instance = null;
    }, 0);
  }

  scheduleEntry();
  const controller = {
    open: (index = 0) => openFeed(index),
    close,
    dispose,
    isOpen: () => isOpen,
  };
  return controller;
}
