/** HMAC verification shared by internal pipeline and preview-build endpoints. */
export async function verifyPipelineSignature(c, rawBody) {
  const secret = c.env.PIPELINE_SECRET;
  const timestamp = c.req.header('X-Mosaic-Time') || '';
  const signature = c.req.header('X-Mosaic-Signature') || '';
  if (!secret || !/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300000) return false;
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
    return crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  } catch {
    return false;
  }
}
