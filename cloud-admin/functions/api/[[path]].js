/**
 * Pages Functions — proxy /api/* to Worker via custom domain.
 * Eliminates CORS preflight: same-origin /api/* → Worker, no OPTIONS overhead.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  return fetch(`https://mosaic-api.xsanye.cn${url.pathname}${url.search}`, context.request);
}
