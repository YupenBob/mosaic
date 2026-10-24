/**
 * Feed motion helpers: reduced-motion detection + double-tap heart particles.
 * Slide snapping itself is a CSS transform transition (see feed.css) so the
 * gesture follows the finger and one spring-like curve is used everywhere; the
 * spring core is used by the note modal (note/motion.js).
 */

/** @returns {boolean} */
export function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Spawn floating hearts at a viewport point (double-tap like). Purely
 * decorative — hidden for reduced-motion users.
 * @param {HTMLElement} layer
 * @param {number} x
 * @param {number} y
 * @param {string} [color]
 */
export function spawnHearts(layer, x, y, color = 'var(--color-like-active, #e74c3c)') {
  if (prefersReducedMotion()) return;
  for (let i = 0; i < 6; i += 1) {
    const heart = document.createElement('span');
    heart.className = 'feed-heart';
    heart.textContent = '♥';
    heart.style.left = `${x}px`;
    heart.style.top = `${y}px`;
    heart.style.color = color;
    heart.style.setProperty('--dx', `${(Math.random() - 0.5) * 90}px`);
    heart.style.setProperty('--rot', `${(Math.random() - 0.5) * 50}deg`);
    heart.style.setProperty('--delay', `${i * 22}ms`);
    layer.appendChild(heart);
    setTimeout(() => heart.remove(), 1000);
  }
}
