/**
 * Pages Functions — proxy /api/* to Worker API.
 * Bypasses workers.dev GFW block: browser → pages.dev → (internal) → Worker → R2
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const headers = new Headers(context.request.headers);
  // Forward the real visitor IP (CF-Connecting-IP at the Pages edge) so the
  // Worker can dedup views / rate-limit logins per actual user.
  const realIp = headers.get('cf-connecting-ip') || '';
  if (realIp) headers.set('X-Real-IP', realIp);
  // Sign the forwarded IP with a shared secret so direct callers can't spoof it.
  const secret = context.env.PROXY_SECRET || '';
  if (secret) headers.set('X-Mosaic-Proxy', secret);
  return fetch(`https://mosaic-api.xsanye.cn${url.pathname}${url.search}`, new Request(context.request, { headers }));
}
