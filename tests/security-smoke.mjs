/**
 * Security regression: media identity validation and JS-string escaping.
 *
 * These are the two primitives that every admin page relies on when a
 * filename, slug, task id or taxonomy name is interpolated into markup.
 */
import assert from 'node:assert/strict';
import { assetId, validSegment } from '../shared/media-manifest.mjs';
import { jsStr } from '../cloud-admin/js/escape.js';

const unsafe = [
  `x');alert(1)//`,
  `x");alert(1)//`,
  'a`b',
  'a<b',
  'a>b',
  'a\\b',
  'a/b',
  'a\nb',
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
