/**
 * Pointer / touch / wheel navigation for the vertical feed.
 *
 * The gesture layer only reports intent; index.js owns the track transform and
 * player.js owns playback, which keeps this module testable and free of state.
 *  - vertical drag follows the finger with edge resistance,
 *  - release >18% of the viewport (or a fast flick) snaps to the next/previous
 *    slide, a downward flick on the first slide closes the feed,
 *  - wheel gestures are debounced into one slide per 380 ms,
 *  - tap = pause/resume, double-tap = like (300 ms window).
 */
const DRAG_START = 8;
const TAP_MAX_MOVE = 8;
const TAP_MAX_MS = 300;
const DOUBLE_TAP_MS = 300;
const WHEEL_STEP = 60;
const WHEEL_LOCK_MS = 380;

/**
 * @param {{
 *   stage: HTMLElement,
 *   getIndex: () => number,
 *   getCount: () => number,
 *   onDragStart: () => void,
 *   onDrag: (offset: number) => void,
 *   onDragEnd: () => void,
 *   onNavigate: (direction: 1|-1) => void,
 *   onClose: () => void,
 *   onTap: (x: number, y: number) => void,
 *   onDoubleTap: (x: number, y: number) => void,
 * }} handlers
 * @returns {{dispose: () => void}}
 */
export function createGestures(handlers) {
  const { stage } = handlers;
  let state = null;
  let wheelAcc = 0;
  let wheelLockUntil = 0;
  let wheelReset = 0;
  let lastTap = null;
  let tapTimer = 0;
  const abort = new AbortController();
  const { signal } = abort;

  /** @returns {number} */
  const viewportHeight = () => stage.clientHeight || window.innerHeight;

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target.closest('button, a, [data-feed-progress]')) return;
    state = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastTime: performance.now(),
      startTime: performance.now(),
      dragging: false,
      cancelled: false,
    };
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is best-effort */
    }
  }

  /** @param {PointerEvent} event */
  function onPointerMove(event) {
    if (!state || event.pointerId !== state.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.lastTime = performance.now();
    if (!state.dragging) {
      if (Math.abs(dy) > DRAG_START && Math.abs(dy) > Math.abs(dx)) {
        state.dragging = true;
        handlers.onDragStart();
      } else if (Math.abs(dx) > DRAG_START * 2 && Math.abs(dx) > Math.abs(dy)) {
        state.cancelled = true; // horizontal gesture: ignore
      }
      if (!state.dragging) return;
    }
    const index = handlers.getIndex();
    const last = handlers.getCount() - 1;
    let offset = dy;
    if ((index <= 0 && dy > 0) || (index >= last && dy < 0)) offset = dy * 0.35;
    handlers.onDrag(offset);
  }

  /** @param {PointerEvent} event */
  function onPointerUp(event) {
    if (!state || event.pointerId !== state.pointerId) return;
    const current = state;
    state = null;
    try {
      stage.releasePointerCapture(current.pointerId);
    } catch {
      /* ignore */
    }
    const dy = current.lastY - current.startY;
    const elapsed = Math.max(1, performance.now() - current.startTime);
    const velocity = dy / elapsed;
    if (current.dragging) {
      handlers.onDragEnd();
      const threshold = viewportHeight() * 0.18;
      const index = handlers.getIndex();
      if (dy < -threshold || velocity < -0.55) return handlers.onNavigate(1);
      if (dy > threshold || velocity > 0.55) {
        if (index <= 0) return handlers.onClose();
        return handlers.onNavigate(-1);
      }
      return handlers.onDrag(0);
    }
    if (current.cancelled) return;
    const moved = Math.abs(dy) + Math.abs(current.lastX - current.startX);
    if (performance.now() - current.startTime > TAP_MAX_MS || moved > TAP_MAX_MOVE) return;
    registerTap(event.clientX, event.clientY);
  }

  /**
   * Distinguish single tap from double tap without delaying the double-tap.
   * @param {number} x @param {number} y
   */
  function registerTap(x, y) {
    const now = performance.now();
    if (lastTap && now - lastTap.time < DOUBLE_TAP_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < 60) {
      clearTimeout(tapTimer);
      lastTap = null;
      handlers.onDoubleTap(x, y);
      return;
    }
    lastTap = { x, y, time: now };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      lastTap = null;
      handlers.onTap(x, y);
    }, DOUBLE_TAP_MS);
  }

  /** @param {WheelEvent} event */
  function onWheel(event) {
    event.preventDefault();
    const now = performance.now();
    if (now < wheelLockUntil) return;
    clearTimeout(wheelReset);
    wheelAcc += event.deltaY;
    wheelReset = setTimeout(() => {
      wheelAcc = 0;
    }, 220);
    if (Math.abs(wheelAcc) < WHEEL_STEP) return;
    const direction = wheelAcc > 0 ? 1 : -1;
    wheelAcc = 0;
    wheelLockUntil = now + WHEEL_LOCK_MS;
    handlers.onNavigate(direction);
  }

  stage.addEventListener('pointerdown', onPointerDown, { signal });
  stage.addEventListener('pointermove', onPointerMove, { signal });
  stage.addEventListener('pointerup', onPointerUp, { signal });
  stage.addEventListener('pointercancel', onPointerUp, { signal });
  stage.addEventListener('wheel', onWheel, { passive: false, signal });

  return {
    dispose() {
      clearTimeout(tapTimer);
      clearTimeout(wheelReset);
      abort.abort();
      state = null;
    },
  };
}
