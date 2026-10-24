/**
 * Xiaohongshu-style note modal: opens a post as an overlay without navigating.
 *
 * `initNoteModal()` is idempotent (safe to call twice) and returns
 * `{ open, close, dispose, isOpen }`. This module owns the dialog lifecycle:
 *  - intercepts plain left-clicks on `.post-card` inside `.card-grid` only
 *    (modified clicks / middle click / no-JS keep the normal post link);
 *  - lazily fetches `data/notes/<slug>.json` on first open (cached afterwards);
 *  - syncs `?note=<slug>` through the History API (refresh + back button work);
 *  - native <dialog> gives top-layer semantics, with explicit Tab cycling, scroll
 *    locking, Esc / backdrop / close-button dismissal and focus restore;
 *  - falls back to a normal navigation when the note payload cannot be loaded.
 * Carousel/video/music/likes/sharing live in `interactions.js`.
 */
import { loadNote, postUrl, slugFromCard, slugFromLocation } from './data.js';
import { collectMedia, renderNote, renderSkeleton } from './render.js';
import { createNoteInteractions } from './interactions.js';
import { t } from './strings.js';
import { focusInitial, lockScroll, trapFocus } from './focus.js';
import { enter, exit } from './motion.js';

let instance = null;

/**
 * Initialize the note modal.
 * @param {{document?: Document, enabled?: boolean}} [options]
 * @returns {{open: (slug: string) => void, close: () => void, dispose: () => void, isOpen: () => boolean}}
 */
export function initNoteModal(options = {}) {
  if (instance) return instance;
  instance = createNoteModal(options);
  return instance;
}

/** @returns {boolean} feature flag, default on when the config key is absent */
function configEnabled() {
  return window.__MOSAIC_CONFIG?.experience?.modal?.enabled !== false;
}

/**
 * @param {{document?: Document, enabled?: boolean}} options
 * @returns {{open: Function, close: Function, dispose: Function, isOpen: Function}}
 */
function createNoteModal(options = {}) {
  const doc = options.document || document;
  const enabled = options.enabled ?? configEnabled();
  const pageType = doc.body?.dataset.page;
  if (!enabled || (pageType && pageType !== 'list')) {
    return { open() {}, close() {}, dispose() {}, isOpen: () => false };
  }

  /** @type {HTMLDialogElement|null} */
  let dialog = null;
  /** @type {HTMLElement|null} */
  let host = null;
  /** @type {(() => void)|null} */
  let releaseScroll = null;
  /** @type {(() => void)|null} */
  let releaseTrap = null;
  /** @type {HTMLElement|null} */
  let opener = null;
  /** @type {object|null} */
  let current = null;
  let open = false;
  let pushedHistory = false;
  let requestToken = 0;

  const interactions = createNoteInteractions({ doc, getHost: () => host, getNote: () => current });

  function buildDialog() {
    if (dialog) return;
    dialog = doc.createElement('dialog');
    dialog.className = 'note-modal';
    dialog.setAttribute('aria-labelledby', 'note-modal-title');
    host = doc.createElement('div');
    host.className = 'note-panel-host';
    dialog.appendChild(host);
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('keydown', onKeydown);
    doc.body.appendChild(dialog);
    releaseTrap = trapFocus(dialog);
  }

  // ── events ──────────────────────────────────────────────────────────────
  /** @param {MouseEvent} event */
  function onClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target === dialog || target.closest('[data-note-close]')) {
      close();
      return;
    }
    interactions.onClick(event);
  }

  /** @param {Event} event */
  function onCancel(event) {
    event.preventDefault();
    close();
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    interactions.onKeydown(event);
  }

  function onPopState() {
    const slug = slugFromLocation();
    if (slug && !open) return openNote(slug, { syncUrl: false });
    if (!slug && open) return close({ syncUrl: false });
  }

  // ── open / close ────────────────────────────────────────────────────────
  /**
   * @param {string} slug
   * @param {{syncUrl?: boolean, opener?: HTMLElement}} [opts]
   */
  function openNote(slug, opts = {}) {
    if (!slug || (open && current?.slug === slug)) return;
    buildDialog();
    if (open) close({ syncUrl: false, instant: true });
    const token = ++requestToken;
    open = true;
    current = null;
    opener = opts.opener || doc.activeElement;
    releaseScroll = lockScroll();
    host.classList.remove('is-narrow');
    host.innerHTML = renderSkeleton();
    dialog.showModal();
    focusInitial(host);
    enter(host).catch(() => {});
    if (opts.syncUrl !== false && slugFromLocation() !== slug) {
      const url = new URL(doc.defaultView.location.href);
      url.searchParams.set('note', slug);
      doc.defaultView.history.pushState({ mosaicNote: slug }, '', url);
      pushedHistory = true;
    }
    loadNote(slug)
      .then((note) => {
        if (token !== requestToken || !open) return;
        current = { ...note, permalink: postUrl(slug) };
        const liked = (() => {
          try {
            return new Set(JSON.parse(localStorage.getItem('mosaic_likes') || '[]')).has(slug);
          } catch {
            return false;
          }
        })();
        host.innerHTML = renderNote(current, { liked });
        host.classList.toggle('is-narrow', collectMedia(current).length === 0);
        interactions.sync({ liked });
        focusInitial(host);
      })
      .catch(() => {
        if (token !== requestToken) return;
        interactions.cleanup();
        const toast = host.querySelector('.note-toast');
        if (toast) {
          toast.textContent = t('loadFailed');
          toast.hidden = false;
        }
        setTimeout(() => {
          if (open) doc.defaultView.location.assign(postUrl(slug));
        }, 600);
      });
  }

  /**
   * @param {{syncUrl?: boolean, instant?: boolean}} [opts]
   */
  function close(opts = {}) {
    if (!open) return;
    open = false;
    requestToken += 1;
    interactions.cleanup();
    const finish = () => {
      releaseScroll?.();
      releaseScroll = null;
      dialog?.close();
      host.innerHTML = '';
      host.classList.remove('is-narrow');
      current = null;
      try {
        opener?.focus?.({ preventScroll: true });
      } catch {
        /* opener may be gone */
      }
      opener = null;
    };
    const visual = opts.instant ? Promise.resolve() : exit(host).catch(() => {});
    visual.then(finish);
    if (opts.syncUrl !== false) {
      if (pushedHistory) {
        pushedHistory = false;
        doc.defaultView.history.back();
      } else {
        const url = new URL(doc.defaultView.location.href);
        url.searchParams.delete('note');
        doc.defaultView.history.replaceState({}, '', url);
      }
    }
  }

  // ── card interception ───────────────────────────────────────────────────
  /** @param {MouseEvent} event */
  function onCardClick(event) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const card = event.target.closest?.('.post-card');
    if (!card || !card.closest('.card-grid') || card.closest('.note-modal')) return;
    const slug = slugFromCard(card);
    if (!slug) return;
    event.preventDefault();
    openNote(slug, { opener: card });
  }

  doc.addEventListener('click', onCardClick);
  doc.defaultView.addEventListener('popstate', onPopState);
  const deepLink = slugFromLocation();
  if (deepLink) openNote(deepLink, { syncUrl: false }); // dialog is created lazily

  return {
    open: (slug) => openNote(slug),
    close: () => close(),
    isOpen: () => open,
    dispose() {
      close({ syncUrl: false, instant: true });
      interactions.cleanup();
      doc.removeEventListener('click', onCardClick);
      doc.defaultView.removeEventListener('popstate', onPopState);
      releaseTrap?.();
      releaseTrap = null;
      dialog?.remove();
      dialog = null;
      host = null;
      instance = null;
    },
  };
}
