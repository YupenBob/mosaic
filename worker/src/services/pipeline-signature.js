/**
 * HMAC verification shared by internal pipeline and preview-build endpoints.
 *
 * Wire format (single release window, backward compatible):
 * - `X-Mosaic-Time`: millisecond timestamp.
 * - `X-Mosaic-Nonce` (optional): lowercase hex, 16..64 chars. When present the
 *   signed message is `${timestamp}.${nonce}.${rawBody}` and the Worker records
 *   the nonce in the Jobs Durable Object so a captured callback cannot be
 *   replayed inside the 5-minute window.
 * - Without a nonce the legacy `${timestamp}.${rawBody}` message is accepted so
 *   old callers keep working until the Actions/scripts side is updated.
 * - `X-Mosaic-Signature`: lowercase hex HMAC-SHA256 of the message above.
 */
export const PIPELINE_NONCE_HEADER = 'X-Mosaic-Nonce';
export const PIPELINE_NONCE_RE = /^[a-f0-9]{16,64}$/;

export function pipelineNonce(c) {
  return c.req.header(PIPELINE_NONCE_HEADER) || '';
}

/** Signed message for a request (exported for tests and clients). */
export function pipelineSignatureMessage(timestamp, nonce, rawBody) {
  return nonce ? `${timestamp}.${nonce}.${rawBody}` : `${timestamp}.${rawBody}`;
}

export async function verifyPipelineSignature(c, rawBody) {
  const secret = c.env.PIPELINE_SECRET;
  const timestamp = c.req.header('X-Mosaic-Time') || '';
  const signature = c.req.header('X-Mosaic-Signature') || '';
  const nonce = pipelineNonce(c);
  if (!secret || !/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300000) return false;
  // A malformed nonce is rejected instead of silently falling back to the
  // legacy message: otherwise an attacker could strip it to bypass replay
  // protection on a nonce-signed caller.
  if (nonce && !PIPELINE_NONCE_RE.test(nonce)) return false;
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const bytes = Uint8Array.from(signature.match(/../g), (pair) => parseInt(pair, 16));
    return crypto.subtle.verify(
      'HMAC',
      key,
      bytes,
      new TextEncoder().encode(pipelineSignatureMessage(timestamp, nonce, rawBody)),
    );
  } catch {
    return false;
  }
}
