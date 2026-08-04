/**
 * Canonical Pages Function proxy for Mosaic.
 *
 * Deployed copies (regenerate with `node scripts/sync-proxy.mjs`):
 *   - functions/api/[[path]].js             (front site -> Worker)
 *   - cloud-admin/functions/api/[[path]].js (admin -> Worker)
 *
 * Forwards /api/* to the Worker API and signs the visitor's real IP with an
 * HMAC-SHA256 (PROXY_SECRET + per-minute bucket) so the Worker can trust
 * X-Mosaic-Proxy-IP without letting direct callers spoof it.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const headers = new Headers(context.request.headers);
  const realIp = headers.get('cf-connecting-ip') || '';
  const secret = context.env.PROXY_SECRET || '';
  if (realIp && secret) {
    const minuteBucket = Math.floor(Date.now() / 60000);
    headers.set('X-Mosaic-Proxy-IP', realIp);
    headers.set('X-Mosaic-Proxy-Time', String(minuteBucket));
    headers.set('X-Mosaic-Proxy-Sig', await hmacHex(secret, `${realIp}:${minuteBucket}`));
  }
  return fetch(`https://mosaic-api.xsanye.cn${url.pathname}${url.search}`, new Request(context.request, { headers }));
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
