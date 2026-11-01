/**
 * R2 upload + file serving.
 *
 * Upload strategy:
 * - Small files (<=100MB): Worker-mediated direct upload (uploadDirect) via the
 *   R2 binding. The Workers platform caps request bodies at ~100MB.
 * - Large files: presigned direct-to-R2 PUT (generatePresignedUrl) — the browser
 *   uploads straight to the R2 S3 endpoint, bypassing the Worker body relay.
 *   uploadComplete() verifies the object landed and marks the site dirty.
 */
import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { verifyToken } from './auth.js';
import { adjustUsage } from './usage.js';
import { markDirty } from './github.js';
import { DEFAULTS } from '../../shared/config.mjs';
import { getConfig } from './services/site-config.js';
import { registerAssetUpload, registerUpload, invalidateMedia, jobsRequest } from './services/jobs.js';
import { parseKeepSource } from './jobs/media-options.mjs';
import { folderFor, validSegment, mediaUrl, compareMediaOrder } from '../../shared/media-manifest.mjs';
import { ASSET_ID_RE } from '../../shared/media-v2.mjs';
import { protectedMediaKeys } from './services/media-references.js';

// Workers platform request-body limit (~100MB). Larger files must use the
// presigned direct-to-R2 upload path.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// Multipart part size bounds (R2 allows up to 10,000 parts; 5MB..1GB per part).
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 1024 * 1024 * 1024;
const MAX_PARTS = 10000;

function s3Client(c) {
  const accountId = c.env.CF_ACCOUNT_ID || '';
  const endpoint = c.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  const accessKey = c.env.R2_ACCESS_KEY || '';
  const secretKey = c.env.R2_SECRET_KEY || '';
  if (!accessKey || !secretKey || !endpoint) return null;
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });
}

// The AWS SDK's XML *deserializer* uses DOMParser, which doesn't exist in the
// Workers runtime. Multipart flows therefore never call client.send(): they
// sign requests with getSignedUrl (no parsing) and talk to the S3 endpoint
// directly via fetch, parsing the small XML payloads with regex.
function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : '';
}

function xmlDecode(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function signedFetch(signedUrl, method, body, extraHeaders = {}) {
  const resp = await fetch(signedUrl, {
    method,
    body,
    headers: body ? { 'Content-Type': 'application/xml', ...extraHeaders } : extraHeaders,
  });
  if (!resp.ok && resp.status !== 204) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`R2 S3 ${method} failed: ${resp.status} ${text.slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return resp;
}

async function listUploadedParts(client, bucket, key, uploadId, expires = DEFAULTS.upload.presignSeconds) {
  const url = await getSignedUrl(client, new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), {
    expiresIn: expires,
  });
  const resp = await signedFetch(url, 'GET');
  const xml = await resp.text();
  const parts = [];
  const partRe = /<Part>([\s\S]*?)<\/Part>/g;
  let m;
  while ((m = partRe.exec(xml))) {
    parts.push({
      partNumber: parseInt(xmlDecode(xmlTag(m[1], 'PartNumber'))) || 0,
      size: parseInt(xmlDecode(xmlTag(m[1], 'Size'))) || 0,
      // R2 returns the ETag pre-escaped (e.g. &quot;hash&quot;); decode so the
      // complete body re-encodes it exactly once.
      etag: xmlDecode(xmlTag(m[1], 'ETag')),
    });
  }
  return parts;
}

const EXT_CONTENT_TYPE = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  txt: 'text/plain',
  json: 'application/json',
  md: 'text/markdown',
};

function folderForExt(ext) {
  return folderFor(`file.${ext}`);
}

/**
 * Resolve the optional `keepSource` upload option. JSON endpoints carry it in
 * the body; the direct-upload path streams the file as the request body, so it
 * is read from `?keepSource=` or `X-Mosaic-Keep-Source` instead.
 * @param {object} c - Hono context
 * @param {object} [body] - parsed JSON body when available
 * @returns {boolean|undefined}
 */
function uploadKeepSource(c, body = {}) {
  return (
    parseKeepSource(body.keepSource) ??
    parseKeepSource(typeof c.req.query === 'function' ? c.req.query('keepSource') : undefined) ??
    parseKeepSource(c.req.header('X-Mosaic-Keep-Source'))
  );
}

// Namespaces under the R2 root that the upload/media API must never write into
// on behalf of a caller: they are owned by the pipeline (previews), the cloud
// drafts store (drafts), the media v2 asset lifecycle (assets) and the site
// data writer (site-data). A post slug may not shadow any of them.
export const RESERVED_MEDIA_SEGMENTS = ['assets', 'previews', 'drafts', 'site-data'];
const RESERVED_MEDIA = new Set(RESERVED_MEDIA_SEGMENTS);

// site-data is deliberately minimal: only the favicon family is uploaded
// through the public upload API. Everything else in site-data is written by the
// Worker/pipeline itself and must stay unreachable from user uploads.
export const SITE_DATA_FILES = ['favicon.svg', 'favicon.png', 'favicon.ico', 'favicon.webp'];
const SITE_DATA = new Set(SITE_DATA_FILES);

function invalidMediaName() {
  return Object.assign(new Error('Invalid media name'), { status: 400, code: 'INVALID_PARAMS' });
}

function assertSiteDataFile(filename) {
  if (!SITE_DATA.has(String(filename).toLowerCase())) throw invalidMediaName();
}

function assertMediaSlug(slug) {
  if (!validSegment(slug) || RESERVED_MEDIA.has(slug)) throw invalidMediaName();
}

// site-data is a reserved namespace (favicon etc.): not a post slug, so it is
// never picked up by the pipeline sync and never swept as an orphan.
export function mediaKey(slug, filename) {
  if (!validSegment(filename)) throw invalidMediaName();
  if (slug === 'site-data') {
    assertSiteDataFile(filename);
    return `site-data/${filename}`;
  }
  assertMediaSlug(slug);
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return `originals/${slug}/${folderForExt(ext)}/${filename}`;
}

/** Media v2 keys are independent of any post slug. */
export function assetOriginalKey(assetId, filename) {
  if (!ASSET_ID_RE.test(assetId) || !validSegment(filename)) throw new Error('Invalid asset name');
  return `originals/assets/${assetId}/${filename}`;
}

/** Resolve either a legacy slug upload or a v2 asset upload from a request body. */
function uploadTarget(body = {}) {
  const filename = typeof body.filename === 'string' ? body.filename : '';
  if (body.assetId) {
    if (!ASSET_ID_RE.test(body.assetId) || !filename) throw new Error('Invalid asset upload');
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return {
      assetId: body.assetId,
      filename,
      folder: folderForExt(ext),
      key: assetOriginalKey(body.assetId, filename),
    };
  }
  const slug = body.slug;
  if (!validSegment(filename)) throw invalidMediaName();
  assertMediaSlug(slug);
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return { slug, filename, folder: folderForExt(ext), key: mediaKey(slug, filename) };
}

async function registerTarget(c, target, key, object, extra = {}) {
  if (target.assetId)
    return registerAssetUpload(c, target.assetId, key, object, {
      filename: target.filename,
      folder: target.folder,
      ...extra,
    });
  return registerUpload(c, key, object, extra);
}

// Direct upload via Worker R2 binding — no CORS issues (<=100MB)
export async function uploadDirect(c) {
  const slug = c.req.param('slug');
  const filename = decodeURIComponent(c.req.param('filename'));
  if (!slug || !filename) return c.json({ error: 'slug and filename required', code: 'INVALID_PARAMS' }, 400);

  // Verify JWT inline (gives better CORS behavior for XHR uploads)
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const auth = await verifyToken(c, token);
  if (!auth.ok) {
    return c.json({ error: 'Unauthorized', code: auth.code }, auth.status);
  }

  const length = parseInt(c.req.header('Content-Length') || '0', 10);
  const config = await getConfig(c);
  if (length > Math.min(MAX_UPLOAD_BYTES, config.upload.maxFileBytes)) {
    return c.json(
      { error: 'File too large (max 100MB via Worker; use presigned upload above this)', code: 'PAYLOAD_TOO_LARGE' },
      413,
    );
  }

  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const folder = folderForExt(ext);
  const contentType = EXT_CONTENT_TYPE[ext] || 'application/octet-stream';
  const isSiteData = slug === 'site-data';
  let key;
  try {
    key = mediaKey(slug, filename);
  } catch (error) {
    return c.json({ error: error.message, code: 'INVALID_PARAMS' }, 400);
  }

  await c.env.MEDIA.put(key, c.req.raw.body, { httpMetadata: { contentType } });
  const obj = await c.env.MEDIA.head(key).catch(() => null);
  if (!obj)
    return c.json({ error: 'Uploaded object could not be verified; retry confirmation', code: 'R2_ERROR' }, 503);
  if (obj.size > config.upload.maxFileBytes)
    return c.json({ error: 'File exceeds upload.maxFileBytes', code: 'PAYLOAD_TOO_LARGE' }, 413);
  const keepSource = uploadKeepSource(c);
  const task = await registerUpload(c, key, obj, keepSource === undefined ? {} : { keepSource });
  if (!task?.duplicate) await adjustUsage(c.env, task?.usageDelta ?? obj?.size ?? length, task?.objectDelta ?? 1);
  if (!task) await markDirty(c.env);
  return c.json({
    ok: true,
    key,
    filename,
    folder: isSiteData ? 'site-data' : folder,
    ...(keepSource === undefined ? {} : { keepSource }),
    ...(task || {}),
  });
}

// Confirm a presigned direct upload landed in R2, then mark the site dirty.
export async function uploadComplete(c) {
  const slug = c.req.param('slug');
  const filename = decodeURIComponent(c.req.param('filename'));
  if (!slug || !filename) return c.json({ error: 'slug and filename required', code: 'INVALID_PARAMS' }, 400);
  let key;
  try {
    key = mediaKey(slug, filename);
  } catch (error) {
    return c.json({ error: error.message, code: 'INVALID_PARAMS' }, 400);
  }
  try {
    const body = await c.req.json().catch(() => ({}));
    const obj = await c.env.MEDIA.head(key);
    if (!obj) return c.json({ error: 'Object not found', code: 'NOT_FOUND' }, 404);
    if (obj.size > (await getConfig(c)).upload.maxFileBytes)
      return c.json({ error: 'File exceeds upload.maxFileBytes', code: 'PAYLOAD_TOO_LARGE' }, 413);
    const keepSource = uploadKeepSource(c, body || {});
    const task = await registerUpload(c, key, obj, keepSource === undefined ? {} : { keepSource });
    if (!task) await markDirty(c.env);
    if (!task?.duplicate) await adjustUsage(c.env, task?.usageDelta ?? obj.size ?? 0, task?.objectDelta ?? 1);
    return c.json({
      ok: true,
      key,
      size: obj.size,
      ...(keepSource === undefined ? {} : { keepSource }),
      ...(task || {}),
    });
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 500);
  }
}

// Complete a Media v2 upload and register an independent asset task.
export async function completeAssetUpload(c) {
  const assetIdValue = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const filename = typeof body.filename === 'string' ? body.filename : '';
  if (!ASSET_ID_RE.test(assetIdValue) || !validSegment(filename))
    return c.json({ error: 'assetId and filename required', code: 'INVALID_PARAMS' }, 400);
  const key = assetOriginalKey(assetIdValue, filename);
  try {
    const obj = await c.env.MEDIA.head(key);
    if (!obj) return c.json({ error: 'Object not found', code: 'NOT_FOUND' }, 404);
    const config = await getConfig(c);
    if (obj.size > config.upload.maxFileBytes)
      return c.json({ error: 'File exceeds upload.maxFileBytes', code: 'PAYLOAD_TOO_LARGE' }, 413);
    const keepSource = uploadKeepSource(c, body || {});
    const folder = folderForExt(filename.split('.').pop()?.toLowerCase() || '');
    const task = await registerAssetUpload(c, assetIdValue, key, obj, {
      filename,
      folder,
      ...(body.uploadId ? { uploadId: body.uploadId } : {}),
      ...(keepSource === undefined ? {} : { keepSource }),
    });
    if (!task?.duplicate) await adjustUsage(c.env, task?.usageDelta ?? obj.size ?? 0, task?.objectDelta ?? 1);
    return c.json({
      ok: true,
      assetId: assetIdValue,
      key,
      size: obj.size,
      ...(keepSource === undefined ? {} : { keepSource }),
      ...(task || {}),
    });
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 500);
  }
}

// Delete a media file across originals/ and processed/ (paginated)
export async function deleteMediaFile(c) {
  const slug = c.req.param('slug');
  const filename = c.req.param('file');
  if (!slug || !filename) return c.json({ error: 'slug and file required', code: 'INVALID_PARAMS' }, 400);
  // Only a real post slug can own uploads: never the reserved namespaces
  // (site-data/drafts/previews/assets), and never a traversing segment.
  if (!validSegment(slug) || RESERVED_MEDIA.has(slug) || !validSegment(filename))
    return c.json({ error: 'Invalid media name', code: 'INVALID_PARAMS' }, 400);
  await invalidateMedia(c.env, slug, filename);
  const protectedKeys = await protectedMediaKeys(c.env);
  let deleted = 0;
  let deletedSize = 0;
  for (const prefix of ['originals', 'processed']) {
    let cursor;
    do {
      const opts = { prefix: `${prefix}/${slug}/`, limit: 1000 };
      if (cursor) opts.cursor = cursor;
      const list = await c.env.MEDIA.list(opts);
      for (const obj of list.objects || []) {
        if (obj.key.split('/').pop() === filename && !protectedKeys.has(obj.key)) {
          deletedSize += obj.size || 0;
          await c.env.MEDIA.delete(obj.key);
          deleted++;
        }
      }
      cursor = list.truncated ? list.cursor : null;
    } while (cursor);
  }
  await adjustUsage(c.env, -deletedSize, -deleted);
  return c.json({ ok: true, deleted });
}

// List media from R2 — searches originals/
export async function listMedia(c, mediaBaseOverride) {
  const slug = c.req.param('slug');
  const r2Public = c.env.R2_PUBLIC_URL || mediaBaseOverride || '';
  const seen = new Set();
  const result = { photos: [], videos: [], music: [], covers: [] };
  const tasks = c.env.JOBS ? await jobsRequest(c.env, 'media-list', { slug }) : [];
  const taskByFile = new Map(tasks.map((task) => [`${task.folder}/${task.filename}`, task]));
  const taskByKey = new Map(tasks.filter((task) => task.sourceKey).map((task) => [task.sourceKey, task]));

  const add = (name, size, key = '', manifestItem = null) => {
    const folder = folderForExt(name.split('.').pop()?.toLowerCase() || '');
    const task =
      manifestItem || taskByKey.get(key) || taskByFile.get(`${folder}/${name}`) || taskByFile.get(`covers/${name}`);
    const identity = task?.id || `${folder}/${name}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const sourceKey = task?.sourceKey || key;
    const previewUrl = task?.previewKey
      ? r2Public
        ? mediaUrl(task.previewKey, r2Public)
        : `/api/media/object?key=${encodeURIComponent(task.previewKey)}`
      : '';
    const url =
      r2Public && sourceKey
        ? mediaUrl(sourceKey, r2Public)
        : `/api/media/file/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`;
    const ext = name.split('.').pop()?.toLowerCase();
    const item = {
      name,
      url: task?.sourceAvailable === false ? previewUrl : url,
      size,
      previewUrl,
      ...(task
        ? { id: task.id, status: task.status, taskId: task.taskId, published: task.published, order: task.order }
        : {}),
    };
    if (task?.folder === 'covers') result.covers.push(item);
    else if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'tiff', 'tif'].includes(ext))
      result.photos.push(item);
    else if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(ext)) result.videos.push(item);
    else if (['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'].includes(ext)) result.music.push(item);
  };

  try {
    let cursor;
    do {
      const list = await c.env.MEDIA.list({ prefix: `originals/${slug}/`, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const obj of list.objects || []) {
        const name = obj.key.split('/').pop();
        if (!name || name.startsWith('.')) continue;
        add(name, obj.size, obj.key);
      }
      cursor = list.truncated ? list.cursor : null;
    } while (cursor);
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 502);
  }
  for (const item of tasks) add(item.filename, 0, item.sourceKey, item);
  for (const list of Object.values(result)) list.sort(compareMediaOrder);
  return c.json(result);
}

// ── Range-aware streaming for the Worker-mediated media fallback ──
// When no public media domain is configured, media is streamed through the
// Worker. Video players (and Safari in particular) probe with `Range:`; a 200
// full-body response makes them download the whole file before playback. A
// single byte range is enough (multipart ranges are not used by players).
const RANGE_RE = /^bytes=(\d+)-(\d*)$/;

function parseRange(header) {
  const match = RANGE_RE.exec(String(header || '').trim());
  if (!match) return null;
  const offset = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(offset) || offset < 0 || end < offset) return null;
  return { offset, end };
}

function rangeOption(range) {
  if (!range) return undefined;
  return {
    range: { offset: range.offset, ...(Number.isFinite(range.end) ? { length: range.end - range.offset + 1 } : {}) },
  };
}

function requestRange(c) {
  try {
    return typeof c.req.header === 'function' ? parseRange(c.req.header('Range')) : null;
  } catch {
    return null;
  }
}

function serveObject(obj, range, cacheControl) {
  const total = typeof obj.size === 'number' ? obj.size : undefined;
  const headers = {
    'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
    'Cache-Control': cacheControl,
    ETag: obj.httpEtag || '',
    // Media fetched via hls.js (XHR/fetch) requires CORS; R2's own edge
    // responses sometimes omit it on cached range responses.
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
  };
  if (range && total !== undefined) {
    const offset = obj.range?.offset ?? range.offset;
    if (offset >= total) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' },
      });
    }
    const end = Number.isFinite(range.end) ? Math.min(range.end, total - 1) : total - 1;
    return new Response(obj.body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${offset}-${end}/${total}` },
    });
  }
  return new Response(obj.body, { status: 200, headers });
}

// Serve an object by its manifest key when no public media domain is configured.
// Only processed/originals namespaces are reachable; arbitrary keys are rejected.
export async function serveMediaObject(c) {
  const key = String(c.req.query('key') || '');
  if (!/^(processed|originals)\//.test(key) || key.includes('..') || key.includes('\\')) {
    return c.json({ error: 'Invalid media key', code: 'INVALID_PARAMS' }, 400);
  }
  try {
    const range = requestRange(c);
    const obj = await c.env.MEDIA.get(key, rangeOption(range));
    if (!obj) return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
    return serveObject(obj, range, 'public, max-age=31536000, immutable');
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 502);
  }
}

// Serve a media file from R2. The folder is derived from the file extension so
// a miss costs at most two GETs (processed, then originals) instead of the old
// 10-prefix sweep.
export async function serveMediaFile(c) {
  const slug = c.req.param('slug');
  const filename = c.req.param('filename');

  if (slug === 'site-data') {
    // Public site-data reads are restricted to the favicon whitelist.
    if (!SITE_DATA.has(String(filename).toLowerCase()))
      return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
    try {
      const range = requestRange(c);
      const obj = await c.env.MEDIA.get(`site-data/${filename}`, rangeOption(range));
      if (obj) return serveObject(obj, range, 'public, max-age=86400');
    } catch {}
    return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
  }

  if (!validSegment(slug) || !validSegment(filename))
    return c.json({ error: 'Invalid media name', code: 'INVALID_PARAMS' }, 400);

  // Folder is derived from the extension: processed (compressed) first, then
  // the original. Two GETs worst case.
  const folder = folderForExt(filename.split('.').pop()?.toLowerCase() || '');
  const range = requestRange(c);
  for (const prefix of ['processed', 'originals']) {
    const key = `${prefix}/${slug}/${folder}/${filename}`;
    try {
      const obj = await c.env.MEDIA.get(key, rangeOption(range));
      if (obj) return serveObject(obj, range, 'public, max-age=31536000');
    } catch {}
  }
  return c.json({ error: 'File not found', code: 'NOT_FOUND' }, 404);
}

// Presigned direct upload: browser → R2 S3 endpoint (single hop, >100MB capable)
export async function generatePresignedUrl(c, input) {
  const body = input || (await c.req.json().catch(() => ({})));
  let target;
  try {
    target = uploadTarget(body);
  } catch (error) {
    return c.json({ error: error.message, code: 'INVALID_PARAMS' }, 400);
  }
  const { filename } = target;
  const keepSource = parseKeepSource(body.keepSource);

  const client = s3Client(c);
  if (!client) {
    return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);
  }

  const config = await getConfig(c);
  const bucket = config.mediaSource.bucket;
  const key = target.key;
  // ContentType intentionally NOT signed so the browser may send its own
  // Content-Type without breaking the SigV4 signature match.
  const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: config.upload.presignSeconds,
  });
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return c.json({
    url,
    key,
    ...(target.assetId ? { assetId: target.assetId } : { slug: target.slug }),
    folder: target.folder,
    expires: config.upload.presignSeconds,
    contentType: body.contentType || EXT_CONTENT_TYPE[ext] || 'application/octet-stream',
    // Registration happens at /upload/complete; echo the choice for the client.
    ...(keepSource === undefined ? {} : { keepSource }),
  });
}

/**
 * Start (or resume) a multipart upload for large files.
 * Pass an existing uploadId to re-sign part URLs for that upload (resume);
 * otherwise a new multipart upload is created.
 */
export async function startMultipartUpload(c, input) {
  const body = input || (await c.req.json().catch(() => ({})));
  let target;
  try {
    target = uploadTarget(body);
  } catch (error) {
    return c.json({ error: error.message, code: 'INVALID_PARAMS' }, 400);
  }
  const { contentType, size, partSize, uploadId } = body;
  const client = s3Client(c);
  if (!client) return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);
  const keepSource = parseKeepSource(body.keepSource);

  const config = await getConfig(c);
  const bucket = config.mediaSource.bucket;
  const key = target.key;
  const partBytes = Math.min(MAX_PART_BYTES, Math.max(MIN_PART_BYTES, parseInt(partSize) || config.upload.partSize));
  const totalSize = Math.max(1, parseInt(size) || 0);
  if (totalSize > config.upload.maxFileBytes)
    return c.json({ error: 'File exceeds upload.maxFileBytes', code: 'PAYLOAD_TOO_LARGE' }, 413);
  const partCount = Math.min(MAX_PARTS, Math.max(1, Math.ceil(totalSize / partBytes)));

  try {
    let id = uploadId || '';
    if (!id) {
      // Sign a create-multipart request (no SDK send → no XML deserialization)
      // and POST it directly to the S3 endpoint.
      const url = await getSignedUrl(
        client,
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType || undefined }),
        { expiresIn: config.upload.presignSeconds },
      );
      const resp = await signedFetch(url, 'POST', undefined, contentType ? { 'Content-Type': contentType } : {});
      const xml = await resp.text();
      id = xmlTag(xml, 'UploadId');
      if (!id) throw new Error('Multipart upload creation failed: ' + xml.slice(0, 200));
    } else {
      // Resume: verify the upload still exists before handing out part URLs.
      try {
        await listUploadedParts(client, bucket, key, id);
      } catch (e) {
        if (e.status === 404) return c.json({ error: 'Upload not found', code: 'NOT_FOUND' }, 404);
        throw e;
      }
    }

    const parts = [];
    for (let i = 1; i <= partCount; i++) {
      const url = await getSignedUrl(
        client,
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: id, PartNumber: i }),
        { expiresIn: config.upload.presignSeconds },
      );
      parts.push({ partNumber: i, url });
    }
    return c.json({
      ok: true,
      uploadId: id,
      key,
      ...(target.assetId ? { assetId: target.assetId } : { slug: target.slug }),
      folder: target.folder,
      partSize: partBytes,
      partCount,
      parts,
      expires: config.upload.presignSeconds,
      ...(keepSource === undefined ? {} : { keepSource }),
    });
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 500);
  }
}

// List already-uploaded parts (client uses this to skip them on resume).
export async function listMultipartParts(c, input) {
  const body = input || (await c.req.json().catch(() => ({})));
  let target;
  try {
    target = uploadTarget(body);
  } catch (error) {
    return c.json({ error: error.message, code: 'INVALID_PARAMS' }, 400);
  }
  const { uploadId } = body;
  if (!uploadId) return c.json({ error: 'uploadId required', code: 'INVALID_PARAMS' }, 400);
  const client = s3Client(c);
  if (!client) return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);
  const config = await getConfig(c);
  const bucket = config.mediaSource.bucket;
  const key = target.key;
  try {
    const parts = await listUploadedParts(client, bucket, key, uploadId, config.upload.presignSeconds);
    return c.json({ ok: true, parts });
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 500);
  }
}

// Complete a multipart upload (server assembles parts from R2) and mark dirty.
export async function completeMultipartUpload(c, input) {
  const body = input || (await c.req.json().catch(() => ({})));
  let target;
  try {
    target = uploadTarget(body);
  } catch (error) {
    return c.json({ error: error.message, code: 'INVALID_PARAMS' }, 400);
  }
  const { uploadId } = body;
  if (!uploadId) return c.json({ error: 'uploadId required', code: 'INVALID_PARAMS' }, 400);
  const keepSource = parseKeepSource(body.keepSource);
  const client = s3Client(c);
  if (!client) return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);
  const config = await getConfig(c);
  const bucket = config.mediaSource.bucket;
  const key = target.key;
  try {
    if (c.env.JOBS) {
      const receipt = await jobsRequest(c.env, 'upload-receipt', { uploadId, key });
      if (receipt)
        return c.json({
          ok: true,
          key,
          size: receipt.source.size,
          taskId: receipt.id,
          status: receipt.status,
          duplicate: true,
        });
    }
    const parts = await listUploadedParts(client, bucket, key, uploadId, config.upload.presignSeconds);
    if (!parts.length) return c.json({ error: 'No parts uploaded', code: 'INVALID_PARTS' }, 400);
    const url = await getSignedUrl(
      client,
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
      // The presigned URL pins content-length to the SDK's own serialization;
      // xmlBody above is byte-identical, so the signature holds.
      { expiresIn: config.upload.presignSeconds },
    );
    // Byte-identical to the SDK's own serialization: the presigned URL pins
    // content-length, so a hand-built body must match exactly (XML declaration,
    // xmlns, escaped ETag, ETag-before-PartNumber member order).
    const esc = (s) =>
      String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const xmlBody =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      parts.map((p) => `<Part><ETag>${esc(p.etag)}</ETag><PartNumber>${p.partNumber}</PartNumber></Part>`).join('') +
      '</CompleteMultipartUpload>';
    await signedFetch(url, 'POST', xmlBody);
    const obj = await c.env.MEDIA.head(key).catch(() => null);
    if (!obj) throw new Error('Completed multipart object is missing');
    if (obj.size > config.upload.maxFileBytes)
      return c.json({ error: 'File exceeds upload.maxFileBytes', code: 'PAYLOAD_TOO_LARGE' }, 413);
    const task = await registerTarget(c, target, key, obj, {
      uploadId,
      ...(keepSource === undefined ? {} : { keepSource }),
    });
    if (!task) await markDirty(c.env);
    if (!task?.duplicate) await adjustUsage(c.env, task?.usageDelta ?? obj.size ?? 0, task?.objectDelta ?? 1);
    return c.json({
      ok: true,
      key,
      ...(target.assetId ? { assetId: target.assetId } : { slug: target.slug }),
      size: obj.size,
      ...(keepSource === undefined ? {} : { keepSource }),
      ...(task || {}),
    });
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 500);
  }
}

// Abort a multipart upload (cleanup when the client cancels).
export async function abortMultipartUpload(c, input) {
  const body = input || (await c.req.json().catch(() => ({})));
  let target;
  try {
    target = uploadTarget(body);
  } catch (error) {
    return c.json({ error: error.message, code: 'INVALID_PARAMS' }, 400);
  }
  const { uploadId } = body;
  if (!uploadId) return c.json({ error: 'uploadId required', code: 'INVALID_PARAMS' }, 400);
  const client = s3Client(c);
  if (!client) return c.json({ error: 'R2 credentials not configured', code: 'CONFIG_ERROR' }, 500);
  const config = await getConfig(c);
  const bucket = config.mediaSource.bucket;
  const key = target.key;
  try {
    const url = await getSignedUrl(
      client,
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      { expiresIn: config.upload.presignSeconds },
    );
    await signedFetch(url, 'DELETE');
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message, code: 'R2_ERROR' }, 500);
  }
}
