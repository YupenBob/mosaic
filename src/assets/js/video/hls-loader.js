/**
 * On-demand loader for the vendored hls.js bundle.
 *
 * Decode-flow principle: the 415 KB hls.js vendor script is never part of the
 * initial page payload. It is only requested when a player on the page first
 * needs an MSE decode path (or an overlay feed opens). Loading is idempotent,
 * retried once and degrades gracefully:
 *
 * - an already-present usable `window.Hls` (test stub, warmed cache, overlay
 *   feed) resolves `true` immediately and never triggers a network request;
 * - native HLS platforms (iOS/Safari) resolve `true` without downloading hls.js;
 * - otherwise the script is appended once and resolves `true`/`false`.
 */

/** Marker path segment used to locate the site root from the module URL. */
const ASSETS_JS = '/assets/js/';
const VENDOR_PATH = 'assets/vendor/hls.min.js';

let loadingPromise = null;

/** Usable hls.js global (supports capabilities query) or false. */
export function hasHlsJs() {
  const Hls = typeof window !== 'undefined' ? window.Hls : undefined;
  if (!Hls) return false;
  try {
    return typeof Hls.isSupported === 'function' ? Hls.isSupported() !== false : true;
  } catch {
    return false;
  }
}

/** Whether this browser can decode HLS natively (Safari/iOS). */
export function nativeHlsSupported(element) {
  const video = element || (typeof document !== 'undefined' ? document.createElement('video') : null);
  try {
    return !!video && typeof video.canPlayType === 'function' && !!video.canPlayType('application/vnd.apple.mpegurl');
  } catch {
    return false;
  }
}

/** Media Source Extensions availability (required by hls.js). */
export function canUseMse() {
  if (typeof window === 'undefined') return false;
  return typeof window.MediaSource !== 'undefined' || typeof window.ManagedMediaSource !== 'undefined';
}

/**
 * Absolute site base URL derived from this module (works for the bundled
 * `assets/js/app.<hash>.js`, the unbundled `assets/js/video/hls-loader.js` and
 * sub-path deployments) with a `<script>`/document fallback.
 * @returns {string} URL ending with `/`
 */
export function siteBase() {
  if (typeof window !== 'undefined') {
    const explicit = window.__MOSAIC_CONFIG?.player?.hls?.vendorBase;
    if (explicit) {
      try {
        return new URL(explicit, document.baseURI).href.replace(/\/?$/, '/');
      } catch {
        /* fall through */
      }
    }
  }
  try {
    const self = new URL(import.meta.url);
    const at = self.pathname.indexOf(ASSETS_JS);
    if (at >= 0 && /^https?:$/.test(self.protocol)) return self.origin + self.pathname.slice(0, at + 1);
  } catch {
    /* import.meta unavailable (classic script sandbox) */
  }
  try {
    const script = document.querySelector('script[src*="/assets/js/"]');
    if (script) {
      const url = new URL(script.src);
      const at = url.pathname.indexOf(ASSETS_JS);
      if (at >= 0) return url.origin + url.pathname.slice(0, at + 1);
    }
  } catch {
    /* non-browser context */
  }
  return '/';
}

/** Absolute URL of the vendored hls.js file. */
export function hlsVendorUrl() {
  try {
    return new URL(VENDOR_PATH, siteBase()).href;
  } catch {
    return `/${VENDOR_PATH}`;
  }
}

function appendScript(src) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || !document.head) {
      reject(new Error('hls.js loader requires a document'));
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(`hls.js failed to load: ${src}`));
    };
    document.head.appendChild(script);
  });
}

async function loadWithRetry() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await appendScript(attempt === 0 ? hlsVendorUrl() : `${hlsVendorUrl()}?retry=${Date.now()}`);
    } catch {
      /* retry once, then report the fallback path */
    }
    if (hasHlsJs()) return true;
  }
  return false;
}

/**
 * Ensure an HLS decode path is available.
 * Idempotent: concurrent and repeated calls share one request.
 * hls.js is preferred whenever MSE exists (the measured, consistent decode
 * path); native HLS is the no-download fallback for platforms without MSE.
 * @returns {Promise<boolean>} true when hls.js loaded or native HLS is usable
 */
export function ensureHlsLoaded() {
  if (hasHlsJs()) return Promise.resolve(true);
  if (!canUseMse() && nativeHlsSupported()) return Promise.resolve(true);
  if (!loadingPromise) {
    loadingPromise = loadWithRetry().then((ready) => {
      if (!ready) loadingPromise = null; // allow a later retry after a transient failure
      return ready;
    });
  }
  return loadingPromise;
}
