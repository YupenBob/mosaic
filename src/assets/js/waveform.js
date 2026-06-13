/**
 * Waveform Visualization — Canvas-based audio waveform renderer.
 * Supports click-to-seek and progress indication.
 */

/**
 * Create a waveform renderer on a canvas element.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} peaks - Normalized amplitude values [0..1]
 * @param {Object} options
 * @param {string} [options.color] - Bar color
 * @param {string} [options.progressColor] - Played portion color
 * @param {number} [options.barWidth] - Width of each bar in px
 * @param {number} [options.barGap] - Gap between bars in px
 * @param {Function} [options.onSeek] - Called with fraction [0..1] on click
 */
export function createWaveform(canvas, peaks, options = {}) {
  const {
    color = 'var(--color-accent)',
    progressColor = 'var(--color-text-primary)',
    barWidth = 3,
    barGap = 1,
    onSeek = null,
  } = options;

  const ctx = canvas.getContext('2d');
  let progress = 0; // 0..1

  /** Get computed CSS variable value */
  function cssVar(name) {
    const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    // Handle hex colors
    if (val.startsWith('#')) return val;
    return val;
  }

  /** Draw the waveform */
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width * dpr;
    const h = rect.height * dpr;

    canvas.width = w;
    canvas.height = h;
    ctx.scale(dpr, dpr);

    const canvasW = rect.width;
    const canvasH = rect.height;
    const midY = canvasH / 2;

    const totalBarWidth = barWidth + barGap;
    const maxBars = Math.floor(canvasW / totalBarWidth);
    // Downsample peaks to fit canvas
    const step = Math.max(1, Math.floor(peaks.length / maxBars));
    const sampled = [];
    for (let i = 0; i < peaks.length; i += step) {
      let chunkMax = 0;
      for (let j = 0; j < step && i + j < peaks.length; j++) {
        chunkMax = Math.max(chunkMax, peaks[i + j]);
      }
      sampled.push(chunkMax);
    }

    const barColor = cssVar('--color-accent') || '#4361ee';
    const doneColor = cssVar('--color-text-primary') || '#1d1d1f';

    sampled.forEach((peak, i) => {
      const x = i * totalBarWidth;
      const barH = Math.max(2, peak * canvasH * 0.8);
      const y = midY - barH / 2;

      // Color based on progress
      const barProgressPos = sampled.length > 0 ? i / sampled.length : 0;
      ctx.fillStyle = barProgressPos <= progress ? doneColor : barColor;
      ctx.fillRect(x, y, barWidth, barH);

      // Mirror (bottom half)
      ctx.fillRect(x, midY + barH / 2, barWidth, -barH);
      ctx.fillRect(x, midY + barH / 2, barWidth, 2);
    });
  }

  /** Update progress position */
  function setProgress(pct) {
    progress = Math.max(0, Math.min(1, pct));
    draw();
  }

  /** Handle click to seek */
  if (onSeek) {
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      onSeek(pct);
    });
  }

  // Initial draw
  draw();

  // Redraw on resize
  const resizeObserver = new ResizeObserver(() => draw());
  resizeObserver.observe(canvas);

  return { setProgress, draw };
}
