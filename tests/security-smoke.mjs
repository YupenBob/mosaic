/**
 * Security regression: media identity validation and JS-string escaping.
 *
 * These are the two primitives that every admin page relies on when a
 * filename, slug, task id or taxonomy name is interpolated into markup.
 */
import assert from 'node:assert/strict';
import { assetId, validSegment } from '../shared/media-manifest.mjs';
import { jsStr } from '../cloud-admin/js/escape.js';
import { contentsUrl } from '../worker/src/services/github-client.js';
import { deletePost } from '../worker/src/services/content.js';
import { mediaKey, SITE_DATA_FILES } from '../worker/src/r2.js';
import { clientIp, passwordMatches } from '../worker/src/auth.js';
import { validStatsSlug } from '../worker/src/stats-do.js';
import { validTrackSlug } from '../worker/src/routes/stats.js';
import {
  pipelineNonce,
  pipelineSignatureMessage,
  PIPELINE_NONCE_RE,
} from '../worker/src/services/pipeline-signature.js';

const unsafe = [
  `x');alert(1)//`,
  `x");alert(1)//`,
  'a`b',
  'a<b',
  'a>b',
  'a\\b',
  'a/b',
  'a\nb',
  'a%b',
  'a?b',
  'a#b',
  '%2e%2e',
  '%252e%252e',
  'a\rb',
  '.',
  '..',
  '',
  null,
  undefined,
];
for (const value of unsafe) assert.equal(validSegment(value), false, `must reject ${JSON.stringify(value)}`);

for (const value of ['秋日的光.jpg', 'clip 01.mp4', 'photo-1.png', 'A&B.webp', 'cover.v2.jpg', '日本語.m4a'])
  assert.equal(validSegment(value), true, `must accept ${value}`);

const url = contentsUrl({ env: { GITHUB_REPO: 'owner/repo' } }, 'content/posts/%3F/index.md');
assert.ok(url.includes('/contents/content/posts/%253F/index.md'), 'contents paths are encoded per segment');
await assert.rejects(() => deletePost({ env: { GITHUB_REPO: 'owner/repo' } }, '?'), /Invalid post slug/);
await assert.rejects(() => deletePost({ env: { GITHUB_REPO: 'owner/repo' } }, '%252e%252e'), /Invalid post slug/);
assert.throws(() => assetId('post', `x');alert(1)//`, 'photos'), /Invalid media name/);
assert.equal(assetId('post', 'cover.jpg', 'covers'), 'post/covers/cover.jpg');

const payload = `x');alert(1)//\u2028<script>&"`;
const escaped = jsStr(payload);
assert.match(escaped, /^&quot;/, 'output is an HTML-safe quoted JS literal');
assert.ok(!escaped.includes(`'`), 'single quotes are entity-escaped');
assert.ok(!escaped.includes(`"`), 'double quotes are entity-escaped');
assert.ok(!escaped.includes('<') && !escaped.includes('>'), 'angle brackets are entity-escaped');
assert.ok(escaped.includes('\\u2028'), 'line separators are escaped for JavaScript');

// Normal values remain a single JS string literal once the HTML parser decodes
// the attribute entities: `"a b"`, `"秋日.jpg"`.
assert.equal(jsStr('a b'), '&quot;a b&quot;');
assert.equal(jsStr('秋日.jpg'), '&quot;秋日.jpg&quot;');
assert.equal(jsStr(null), '&quot;&quot;');

console.log('Security smoke: segment validation and JS-string escaping passed');

// ── Worker R2 write channels: site-data whitelist + reserved namespaces ──
for (const name of SITE_DATA_FILES) assert.equal(mediaKey('site-data', name), `site-data/${name}`);
for (const name of ['robots.txt', 'favicon.exe', 'app.js', '..', 'a/b.svg'])
  assert.throws(() => mediaKey('site-data', name), /Invalid media name/, `site-data/${name} must be rejected`);
for (const slug of ['assets', 'previews', 'drafts']) assert.throws(() => mediaKey(slug, 'x.jpg'), /Invalid media name/);
assert.equal(mediaKey('post', 'cover.jpg'), 'originals/post/photos/cover.jpg');
assert.equal(mediaKey('post', 'clip.mp4'), 'originals/post/videos/clip.mp4');

// ── Fail-closed client IP + constant-time password comparison ──
const headerIp = (env, headers) => {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return clientIp({ env, req: { header: (name) => lower[name.toLowerCase()] || '' } });
};
assert.equal(
  await headerIp({ DEV_MODE: 'false' }, { 'X-Real-IP': '1.2.3.4', 'CF-Connecting-IP': '5.6.7.8' }),
  '5.6.7.8',
  'X-Real-IP must not be trusted without the proxy HMAC',
);
assert.equal(
  await headerIp({ DEV_MODE: 'true' }, { 'X-Real-IP': '1.2.3.4' }),
  '1.2.3.4',
  'DEV_MODE keeps local fallback',
);
assert.equal(await passwordMatches('admin123', 'admin123'), true);
assert.equal(await passwordMatches('admin124', 'admin123'), false);
assert.equal(await passwordMatches('', 'admin123'), false);
assert.equal(await passwordMatches(undefined, undefined), true, 'both unset cannot throw');

// ── Stats tracking slug rules (DO + Worker route agree) ──
for (const slug of ['', '.', '..', 'a/b', 'a\\b', 'a'.repeat(121), 'a\u0000b'])
  assert.equal(validStatsSlug(slug), false, `stats must reject ${JSON.stringify(slug)}`);
for (const slug of ['my-post', '秋日的光', 'a b', 'a'.repeat(120)])
  assert.equal(validStatsSlug(slug), true, `stats must accept ${slug}`);
for (const slug of ['', '..', 'a/b', 'a'.repeat(121), 'a\u0001b'])
  assert.equal(validTrackSlug(slug), false, `track must reject ${JSON.stringify(slug)}`);
assert.equal(validTrackSlug('my-post'), true);

// ── Pipeline HMAC: optional nonce is part of the signed message ──
assert.equal(pipelineSignatureMessage('123', '', '{}'), '123.{}');
assert.equal(pipelineSignatureMessage('123', 'a'.repeat(16), '{}'), `123.${'a'.repeat(16)}.{}`);
assert.equal(PIPELINE_NONCE_RE.test('0123456789abcdef'), true);
assert.equal(PIPELINE_NONCE_RE.test('0123456789ABCDEF'), false, 'nonce must be lowercase hex');
assert.equal(PIPELINE_NONCE_RE.test('short'), false);
const noNonceReq = { req: { header: () => '' } };
assert.equal(pipelineNonce(noNonceReq), '');

console.log('Security smoke: segment validation, R2 write channels, auth fail-closed and HMAC nonce passed');
