/**
 * Touch/pointer gestures on the video surface:
 * - single tap / click: play-pause (double-click aware so it does not fight
 *   the ±10s double-tap);
 * - double tap or double click on the left/right half: skip ∓10s;
 * - long press: temporary 2× speed while held (restored on release);
 * - all overlays are transient and pointer-events:none.
 */

const TOGGLE_DELAY = 240;
const DOUBLE_TAP_MS = 300;
const LONG_PRESS_MS = 450;

/**
 * @param {import('./player.js').VideoPlayer} player
 */
export function initGestures(player) {
  const container = player.container;
  const video = player.video;
  if (!container || !video) return;
  const signal = player.lifecycle.signal;
  const on = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal });
  const insideControls = (target) =>
    !!target?.closest?.('.video-controls, .video-big-play, button, a, input, select, textarea');

  let toggleTimer = null;
  let lastTapAt = 0;
  let tapTimer = null;
  let pressTimer = null;
  let boosted = false;
  let baseRate = 1;
  let suppressTapUntil = 0;

  const skipByPoint = (clientX, seconds) => {
    const rect = container.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = (clientX - rect.left) / rect.width;
    if (ratio >= 0.4 && ratio <= 0.6) return;
    const delta = ratio < 0.5 ? -seconds : seconds;
    player.playback?.seek(video.currentTime + delta);
    player.showOverlay(delta < 0 ? `« ${seconds}s` : `${seconds}s »`);
  };

  // Desktop: click toggles after a short delay so dblclick can claim the pair.
  on(container, 'click', (event) => {
    if (insideControls(event.target)) return;
    if (Date.now() - (player._lastTouch || 0) < 700) return; // synthetic click after touch
    if (event.detail > 1) {
      if (toggleTimer) clearTimeout(toggleTimer);
      toggleTimer = null;
      return;
    }
    if (toggleTimer) return;
    toggleTimer = setTimeout(() => {
      toggleTimer = null;
      player.togglePlay();
    }, TOGGLE_DELAY);
  });

  on(container, 'dblclick', (event) => {
    if (insideControls(event.target)) return;
    event.preventDefault();
    if (toggleTimer) {
      clearTimeout(toggleTimer);
      toggleTimer = null;
    }
    skipByPoint(event.clientX, 10);
  });

  // Long press: temporary 2x playback rate.
  on(container, 'pointerdown', (event) => {
    if (insideControls(event.target) || (event.button != null && event.button !== 0)) return;
    player.playback?.prewarm();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      boosted = true;
      baseRate = video.playbackRate || 1;
      try {
        video.playbackRate = Math.min(4, baseRate * 2);
      } catch {
        boosted = false;
        return;
      }
      container.classList.add('boosting');
      player.showOverlay('2× 倍速', 600);
    }, LONG_PRESS_MS);
  });
  const endPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    if (!boosted) return;
    boosted = false;
    container.classList.remove('boosting');
    try {
      video.playbackRate = baseRate;
    } catch {
      /* detached */
    }
    suppressTapUntil = Date.now() + 450;
  };
  on(container, 'pointerup', endPress);
  on(container, 'pointercancel', endPress);
  on(container, 'pointerleave', endPress);

  // Touch: tap toggles, double tap skips ±10s.
  on(
    container,
    'touchend',
    (event) => {
      player._lastTouch = Date.now();
      if (insideControls(event.target) || Date.now() < suppressTapUntil) return;
      const now = Date.now();
      if (now - lastTapAt < DOUBLE_TAP_MS) {
        if (tapTimer) clearTimeout(tapTimer);
        tapTimer = null;
        lastTapAt = 0;
        const touch = event.changedTouches?.[0];
        if (touch) skipByPoint(touch.clientX, 10);
        return;
      }
      lastTapAt = now;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        tapTimer = null;
        lastTapAt = 0;
        player.togglePlay();
      }, DOUBLE_TAP_MS);
    },
    { passive: true },
  );

  signal.addEventListener(
    'abort',
    () => {
      if (toggleTimer) clearTimeout(toggleTimer);
      if (tapTimer) clearTimeout(tapTimer);
      if (pressTimer) clearTimeout(pressTimer);
      toggleTimer = tapTimer = pressTimer = null;
    },
    { once: true },
  );
}
