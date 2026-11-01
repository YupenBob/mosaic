/**
 * On-demand syntax highlighting for pages that actually contain code blocks.
 *
 * The ~120 KB highlight.js vendor bundle and its stylesheet are never part of
 * the initial page payload. `post.ejs` links the stylesheet only when the post
 * renders `<pre><code>` markup and does not inject the vendor script at all;
 * the app registers `highlight` as a lazy component, so the script is requested
 * only when such a code block exists in the DOM (a plain article downloads 0 B
 * of highlighter code).
 *
 * Loading is idempotent, tolerates a missing vendor file (progressive
 * enhancement) and works for bundled (`app.<hash>.js`) and sub-path builds.
 */
import { siteBase } from './video/hls-loader.js';

const VENDOR_PATH = 'assets/vendor/highlight.min.js';

/** @type {Promise<unknown>|null} */
let loadPromise = null;

/** True when the current document has a block the highlighter should process. */
export function hasCodeBlock() {
  return typeof document !== 'undefined' && !!document.querySelector('pre code');
}

/** Inject the vendor script once; resolves with `window.hljs` or null. */
function loadVendor() {
  if (typeof window !== 'undefined' && window.hljs) return Promise.resolve(window.hljs);
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = siteBase() + VENDOR_PATH;
    script.async = true;
    script.onload = () => resolve(window.hljs || null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

/**
 * Highlight every `<pre><code>` block, loading the vendor bundle on first use.
 * Resolves `true` when highlighting ran, `false` when it was skipped/degraded.
 * @returns {Promise<boolean>}
 */
export async function highlightCode() {
  if (!hasCodeBlock()) return false;
  if (!loadPromise) loadPromise = loadVendor();
  const hljs = await loadPromise;
  if (!hljs || typeof hljs.highlightAll !== 'function') return false;
  try {
    hljs.highlightAll();
    return true;
  } catch (error) {
    console.warn('[highlight] failed:', error?.message || error);
    return false;
  }
}
