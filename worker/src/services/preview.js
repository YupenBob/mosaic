/**
 * Private previews: an Actions build writes a static site under
 * `previews/<id>/`, and a short-lived HMAC token serves it from R2.
 *
 * Two tokens exist:
 * - access token (`PREVIEW_SECRET`): readable by the browser, 24h by default.
 * - build token (`PIPELINE_SECRET`): passed to the workflow once so it can read
 *   the draft and report completion without an admin session.
 */
import { getConfig } from './site-config.js';
import { dispatchWorkflow } from './workflows.js';
import { getDraft } from './drafts.js';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const DEFAULT_TTL_HOURS = 24;

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
};

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value) {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))));
}

async function verifyHmac(secret, message, signature) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, fromBase64url(signature), new TextEncoder().encode(message));
}

export function newPreviewId() {
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  let id = 'prv_';
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

export async function signPreviewToken(payload, secret) {
  if (!secret) throw Object.assign(new Error('Preview signing secret is missing'), { status: 503 });
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verifyPreviewToken(token, secret) {
  if (!secret || typeof token !== 'string') return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  try {
    if (!(await verifyHmac(secret, body, signature))) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
    if (!payload || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function previewKey(id, pathname = 'index.html') {
  const clean = String(pathname || 'index.html')
    .replace(/^\/+/, '')
    .replace(/\.\.(\/|$)/g, '');
  return `previews/${id}/${clean || 'index.html'}`;
}

export async function createPreview(c, draftId) {
  const draft = await getDraft(c, draftId);
  const config = await getConfig(c);
  const ttlHours = config.preview?.ttlHours || DEFAULT_TTL_HOURS;
  const now = Date.now();
  const expiresAt = new Date(now + ttlHours * 3600000).toISOString();
  const previewId = newPreviewId();
  const meta = {
    id: previewId,
    draftId,
    slug: draft.slug,
    status: 'queued',
    createdAt: new Date(now).toISOString(),
    expiresAt,
    error: '',
  };
  await c.env.MEDIA.put(`previews/${previewId}/meta.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
  const buildToken = await signPreviewToken(
    { p: previewId, d: draftId, exp: now + 3600000 },
    c.env.PIPELINE_SECRET || c.env.PREVIEW_SECRET,
  );
  try {
    await dispatchWorkflow(
      c,
      'preview',
      {
        preview_id: previewId,
        draft_id: draftId,
        api_base: new URL(c.req.url).origin,
        build_token: buildToken,
      },
      config,
    );
  } catch (error) {
    meta.status = 'failed';
    meta.error = error.message;
    await c.env.MEDIA.put(`previews/${previewId}/meta.json`, JSON.stringify(meta), {
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    });
    throw error;
  }
  return {
    previewId,
    token: await signPreviewToken({ p: previewId, exp: Date.parse(expiresAt) }, c.env.PREVIEW_SECRET),
    expiresAt,
    status: 'queued',
  };
}

export async function getPreviewStatus(c, previewId) {
  if (!/^prv_[a-z0-9]{26}$/.test(previewId || ''))
    throw Object.assign(new Error('Invalid preview id'), { status: 400 });
  const object = await c.env.MEDIA.get(`previews/${previewId}/meta.json`);
  if (!object) throw Object.assign(new Error('Preview not found'), { status: 404 });
  return JSON.parse(await object.text());
}

export async function servePreview(c, token, requestPath) {
  const payload = await verifyPreviewToken(token, c.env.PREVIEW_SECRET);
  if (!payload?.p) return new Response('Preview expired', { status: 410 });
  let pathname = String(requestPath || '').replace(/^\/+/, '');
  if (!pathname || pathname.endsWith('/')) pathname += 'index.html';
  const object = await c.env.MEDIA.get(previewKey(payload.p, pathname));
  if (!object) return new Response('Not found', { status: 404 });
  const ext = pathname.split('.').pop()?.toLowerCase() || 'html';
  return new Response(object.body, {
    headers: {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export async function readPreviewDraft(c, token) {
  const payload = await verifyPreviewToken(token, c.env.PIPELINE_SECRET || c.env.PREVIEW_SECRET);
  if (!payload?.d || !payload?.p) throw Object.assign(new Error('Invalid build token'), { status: 401 });
  const draft = await getDraft(c, payload.d);
  return { draft, previewId: payload.p, expiresAt: payload.exp };
}

export async function finishPreview(c, token, body = {}) {
  const payload = await verifyPreviewToken(token, c.env.PIPELINE_SECRET || c.env.PREVIEW_SECRET);
  if (!payload?.p) throw Object.assign(new Error('Invalid build token'), { status: 401 });
  const key = `previews/${payload.p}/meta.json`;
  const object = await c.env.MEDIA.get(key);
  if (!object) throw Object.assign(new Error('Preview not found'), { status: 404 });
  const meta = JSON.parse(await object.text());
  meta.status = body.ok === false ? 'failed' : 'ready';
  meta.error = body.ok === false ? String(body.error || 'Preview build failed') : '';
  meta.completedAt = new Date().toISOString();
  await c.env.MEDIA.put(key, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
  return meta;
}

/**
 * Delete expired preview sites from R2. Called by the cleanup page; preview
 * tokens are already invalid after expiry, this reclaims storage.
 */
async function listAll(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const listed = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    objects.push(...(listed.objects || []));
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  return objects;
}

export async function cleanupPreviews(c) {
  const listed = await listAll(c.env.MEDIA, 'previews/');
  const ids = new Set();
  for (const object of listed) {
    const id = object.key.split('/')[1];
    if (/^prv_[a-z0-9]{26}$/.test(id)) ids.add(id);
  }
  const deleted = [];
  const now = Date.now();
  for (const id of ids) {
    const metaObject = await c.env.MEDIA.get(`previews/${id}/meta.json`);
    if (!metaObject) continue;
    const meta = JSON.parse(await metaObject.text());
    if (!meta.expiresAt || Date.parse(meta.expiresAt) > now) continue;
    const objects = await listAll(c.env.MEDIA, `previews/${id}/`);
    const keys = objects.map((object) => object.key);
    if (keys.length) await c.env.MEDIA.delete(keys);
    deleted.push(id);
  }
  return { deleted: deleted.length, ids: deleted };
}
