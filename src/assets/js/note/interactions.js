/**
 * Note-modal interactions: media carousel, inline video/music playback and the
 * click dispatcher for social actions. The dialog lifecycle (open/close/History/
 * focus/scroll) lives in `index.js`; likes/share/toasts in `social.js`.
 *
 * All lookups go through the `getHost()` / `getNote()` accessors because the
 * modal host is re-rendered for every note and the dialog itself is reused.
 */
import { collectMedia } from './render.js';
import { postUrl } from './data.js';
import { createNoteSocial } from './social.js';
import { prefersReducedMotion } from './motion.js';

/**
 * @param {{
 *   doc: Document,
 *   getHost: () => HTMLElement|null,
 *   getNote: () => object|null,
 * }} deps
 */
export function createNoteInteractions({ doc, getHost, getNote }) {
  /** @type {Audio|null} */
  let audio = null;
  /** @type {AbortController|null} */
  let renderAbort = null;
  let scrollFrame = 0;
  const social = createNoteSocial({ doc, getHost, getNote });

  // ── carousel ────────────────────────────────────────────────────────────
  function trackEl() {
    return getHost()?.querySelector('.note-media-track');
  }

  function activeIndex() {
    const track = trackEl();
    if (!track) return 0;
    return Math.max(0, Math.round(track.scrollLeft / Math.max(1, track.clientWidth)));
  }

  /** @param {number} index */
  function slideTo(index) {
    const track = trackEl();
    if (!track) return;
    const next = Math.min(Math.max(index, 0), track.children.length - 1);
    track.scrollTo({ left: next * track.clientWidth, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    updateCarousel(next);
  }

  /** @param {number} delta */
  function slideBy(delta) {
    slideTo(activeIndex() + delta);
  }

  /** @param {number} [forced] */
  function updateCarousel(forced) {
    const track = trackEl();
    if (!track) return;
    const index = forced ?? activeIndex();
    const host = getHost();
    host.querySelectorAll('.note-dot').forEach((dot, i) => dot.classList.toggle('active', i === index));
    host.querySelectorAll('.note-media-nav.prev').forEach((el) => (el.disabled = index <= 0));
    host.querySelectorAll('.note-media-nav.next').forEach((el) => (el.disabled = index >= track.children.length - 1));
  }

  function onTrackScroll() {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => updateCarousel());
  }

  // ── inline media ────────────────────────────────────────────────────────
  /**
   * Replace a poster frame with a native video element. HLS-only media is
   * handed to the browser when natively supported, otherwise the post page is
   * opened (playback-quality owns HLS, the modal does not duplicate it).
   * @param {HTMLElement} container
   * @param {object} video
   */
  function mountVideo(container, video) {
    const sources = Object.entries(video.sources || {}).sort(([a], [b]) => parseInt(b, 10) - parseInt(a, 10));
    const nativeHls = doc.createElement('video').canPlayType('application/vnd.apple.mpegurl');
    if (!sources.length && !(video.hls && nativeHls)) {
      const note = getNote();
      if (note) window.location.assign(postUrl(note.slug));
      return;
    }
    const el = doc.createElement('video');
    el.className = 'note-media-video';
    el.controls = true;
    el.playsInline = true;
    el.autoplay = true;
    el.preload = 'auto';
    el.poster = video.poster || '';
    for (const [tier, url] of sources) {
      const source = doc.createElement('source');
      source.src = url;
      source.type = 'video/mp4';
      source.dataset.res = tier;
      el.appendChild(source);
    }
    if (!sources.length) el.src = video.hls;
    container.replaceChildren(el);
    el.play?.().catch(() => {});
  }

  /** @param {number} mediaIndex */
  function playCarouselVideo(mediaIndex) {
    const note = getNote();
    if (!note) return;
    const entry = collectMedia(note)[mediaIndex];
    if (!entry || entry.kind !== 'video') return;
    const frame = getHost()?.querySelector(`.note-media-item[data-media-index="${mediaIndex}"] .note-media-frame`);
    if (!frame || frame.querySelector('video')) return;
    mountVideo(frame, entry.item);
  }

  /** @param {HTMLElement} button */
  function expandInlineVideo(button) {
    // HLS-only video: the post page owns the shared decode controller.
    if (button.hasAttribute('data-open-post')) {
      const note = getNote();
      if (note) window.location.assign(postUrl(note.slug));
      return;
    }
    const card = button.closest('.note-video-card');
    const video = card?.querySelector('video');
    if (!video) return;
    button.hidden = true;
    video.hidden = false;
    if (!video.src && !video.querySelector('source')) return;
    video.play?.().catch(() => {});
  }

  /** @param {HTMLElement} button */
  function toggleTrack(button) {
    const src = button.getAttribute('data-audio-src');
    if (!src) return;
    const host = getHost();
    if (audio && button.classList.contains('playing')) {
      audio.pause();
      button.classList.remove('playing');
      button.innerHTML = '<i class="ri-play-fill" aria-hidden="true"></i>';
      return;
    }
    if (!audio) audio = new Audio();
    if (audio.src !== src) audio.src = src;
    host.querySelectorAll('.note-music-toggle.playing').forEach((el) => {
      el.classList.remove('playing');
      el.innerHTML = '<i class="ri-play-fill" aria-hidden="true"></i>';
    });
    button.classList.add('playing');
    button.innerHTML = '<i class="ri-pause-fill" aria-hidden="true"></i>';
    audio.play().catch(() => button.classList.remove('playing'));
    audio.onended = () => {
      button.classList.remove('playing');
      button.innerHTML = '<i class="ri-play-fill" aria-hidden="true"></i>';
    };
  }

  // ── public surface ──────────────────────────────────────────────────────
  return {
    /**
     * Dispatch a click inside the modal. Returns true when it was consumed.
     * @param {MouseEvent} event
     * @returns {boolean}
     */
    onClick(event) {
      const target = /** @type {HTMLElement} */ (event.target);
      const like = target.closest('[data-note-like]');
      if (like) {
        social.toggle(like, event);
        return true;
      }
      const share = target.closest('[data-note-share]');
      const note = getNote();
      if (share && note) {
        social.share(note);
        return true;
      }
      const nav = target.closest('[data-nav]');
      if (nav) {
        slideBy(Number(nav.getAttribute('data-nav')) || 1);
        return true;
      }
      const dot = target.closest('[data-dot]');
      if (dot) {
        slideTo(Number(dot.getAttribute('data-dot')) || 0);
        return true;
      }
      const carouselPlay = target.closest('[data-video-index]');
      if (carouselPlay && note) {
        playCarouselVideo(Number(carouselPlay.getAttribute('data-video-index')));
        return true;
      }
      const expand = target.closest('[data-expand-video]');
      if (expand) {
        expandInlineVideo(expand);
        return true;
      }
      const music = target.closest('[data-audio-src]');
      if (music) {
        toggleTrack(music);
        return true;
      }
      if (target.closest('.note-media-track')) {
        updateCarousel();
        return true;
      }
      return false;
    },

    /** ArrowLeft/ArrowRight carousel navigation. @param {KeyboardEvent} event */
    onKeydown(event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const note = getNote();
      if (!note || collectMedia(note).length < 2) return;
      const tag = /** @type {HTMLElement} */ (event.target).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      event.preventDefault();
      slideBy(event.key === 'ArrowRight' ? 1 : -1);
    },

    /**
     * Called after the note markup is rendered: wire the carousel scroll
     * listener and restore the liked state from the shared localStorage set.
     * @param {{liked: boolean}} state
     */
    sync(state) {
      renderAbort?.abort();
      renderAbort = new AbortController();
      const host = getHost();
      if (!host) return;
      host.querySelector('.note-toast')?.setAttribute('hidden', '');
      const note = getNote();
      const like = host.querySelector('[data-note-like]');
      const base = Number(note?.stats?.likes || 0);
      if (like) like.dataset.count = String(base + (state?.liked ? 1 : 0));
      if (state?.liked) social.applyLike(like, base + 1, true);
      updateCarousel(0);
      trackEl()?.addEventListener('scroll', onTrackScroll, { passive: true, signal: renderAbort.signal });
    },

    /** Release per-render listeners and playback. */
    cleanup() {
      renderAbort?.abort();
      renderAbort = null;
      cancelAnimationFrame(scrollFrame);
      social.cleanup();
      audio?.pause();
      audio = null;
    },
  };
}
