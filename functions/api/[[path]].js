/**
 * Pages Functions — proxy /api/* to Worker API.
 * Bypasses workers.dev GFW block: browser → pages.dev → (internal) → Worker → R2
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  return fetch(`https://mosaic-api.xsanye.cn${url.pathname}${url.search}`, context.request);
}
