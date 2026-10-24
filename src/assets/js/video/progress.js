/**
 * Progress bar: display (fill/buffer/time/thumb), RAF smoothing and
 * click/mouse/touch scrubbing. All listeners are tied to the player lifecycle
 * signal so destroyed players cannot keep scheduling frames.
 */
import { fmtTime } from './controls.js';

/** RAF-driven progress smoothing; disabled for reduced-motion users. */
export const progressControls = {
  _progressMotionAllowed() {
    if (this._reducedMotion == null) {
      try {
        this._reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      } catch {
        this._reducedMotion = false;
      }
    }
    return !this._reducedMotion;
  },

  /** Update time text, buffer, fill/thumb and ARIA slider state. */
  updateProgress() {
    const video = this.video;
    if (!video) return;
    const duration = video.duration;
    if (this.timeCur) this.timeCur.textContent = fmtTime(video.currentTime);
    if (this.timeDur && Number.isFinite(duration)) this.timeDur.textContent = fmtTime(duration);
    if (this.progressBuffer && Number.isFinite(duration) && video.buffered?.length) {
      let end = 0;
      for (let i = 0; i < video.buffered.length; i += 1) end = Math.max(end, video.buffered.end(i));
      this.progressBuffer.style.width = `${Math.min(100, (end / duration) * 100)}%`;
    }
    const percent = Number.isFinite(duration) && duration > 0 ? Math.min(100, (video.currentTime / duration) * 100) : 0;
    this._paintProgress(percent);
    if (!video.paused && !this._scrubbing && this._progressMotionAllowed()) this._startProgressRaf();
    else this._stopProgressRaf();
  },

  _paintProgress(percent) {
    if (this.progressFill) this.progressFill.style.width = `${percent}%`;
    if (this.progressThumb) this.progressThumb.style.left = `${percent}%`;
    if (this.progressTrack) this.progressTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
  },

  _startProgressRaf() {
    if (this._rafId) return;
    const step = () => {
      const video = this.video;
      if (!video || video.paused || this._scrubbing || this._destroyed) {
        this._rafId = null;
        return;
      }
      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 0) {
        this._paintProgress(Math.min(100, (video.currentTime / duration) * 100));
      }
      this._rafId = requestAnimationFrame(step);
    };
    this._rafId = requestAnimationFrame(step);
  },

  _stopProgressRaf() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  },

  /** Seek to a client X coordinate on the progress track. */
  _seekFromClientX(clientX) {
    const track = this.progressTrack;
    const video = this.video;
    if (!track || !video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    this._paintProgress(ratio * 100);
    if (this.timeCur) this.timeCur.textContent = fmtTime(video.currentTime);
  },

  _hoverFromClientX(clientX) {
    const track = this.progressTrack;
    const video = this.video;
    if (!track || !video || !this.progressTooltip || !Number.isFinite(video.duration)) return;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    this.progressTooltip.textContent = fmtTime(ratio * video.duration);
    this.progressTooltip.style.left = `${ratio * 100}%`;
    this.progressTooltip.style.opacity = '1';
  },
};

/**
 * Bind scrubbing interactions (click, mouse hover, drag, touch scrub).
 * @param {import('./player.js').VideoPlayer} player
 */
export function initProgress(player) {
  const track = player.progressTrack;
  if (!track) return;
  const signal = player.lifecycle.signal;
  const on = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal });

  on(track, 'click', (event) => {
    event.stopPropagation();
    player._seekFromClientX(event.clientX);
  });
  on(track, 'mousemove', (event) => player._hoverFromClientX(event.clientX));
  on(track, 'mouseleave', () => {
    if (player.progressTooltip) player.progressTooltip.style.opacity = '0';
  });

  // Drag scrub: document-level listeners only while dragging.
  let dragHandlers = null;
  const stopDrag = () => {
    player._scrubbing = false;
    if (!dragHandlers) return;
    document.removeEventListener('mousemove', dragHandlers.move);
    document.removeEventListener('mouseup', dragHandlers.up);
    dragHandlers = null;
  };
  on(track, 'mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    player._scrubbing = true;
    player._seekFromClientX(event.clientX);
    if (dragHandlers) stopDrag();
    const move = (moveEvent) => player._seekFromClientX(moveEvent.clientX);
    const up = () => stopDrag();
    dragHandlers = { move, up };
    document.addEventListener('mousemove', move, { signal });
    document.addEventListener('mouseup', up, { signal });
  });

  // Touch scrub (mobile): track is inside the controls, so no gesture conflict.
  let touching = false;
  const touchAt = (event) => {
    const touch = event.changedTouches?.[0];
    if (touch) player._seekFromClientX(touch.clientX);
  };
  on(
    track,
    'touchstart',
    (event) => {
      touching = true;
      player._scrubbing = true;
      touchAt(event);
    },
    { passive: true },
  );
  on(
    track,
    'touchmove',
    (event) => {
      if (touching) touchAt(event);
    },
    { passive: true },
  );
  on(track, 'touchend', () => {
    touching = false;
    player._scrubbing = false;
  });

  player.lifecycle.signal.addEventListener(
    'abort',
    () => {
      stopDrag();
      player._stopProgressRaf();
    },
    { once: true },
  );
}
