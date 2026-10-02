/** Stable cache partition prevents old no-Origin native responses poisoning HLS XHR. */
export function playbackUrl(value) {
  const version = window.__MOSAIC_CONFIG?.player?.requestVersion;
  if (!version || !value) return value;
  const url = new URL(value, document.baseURI);
  url.searchParams.set('mosaic-cors', version);
  return url.href;
}
