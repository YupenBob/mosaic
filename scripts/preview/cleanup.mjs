/**
 * Remove a private preview from R2 (`previews/<previewId>/...`).
 *
 * Used by preview.yml when a build is cancelled or fails so a half-uploaded
 * preview can never be served or counted as valid. Safe to re-run.
 *
 * Usage:
 *   PREVIEW_ID=prv_xxx R2_... node scripts/preview/cleanup.mjs
 *   PREVIEW_ID=prv_xxx node scripts/preview/cleanup.mjs --dry-run
 */
import { createStorage } from '../media/storage.mjs';
import { loadContext } from '../lib/context.mjs';

const PREVIEW_ID_RE = /^prv_[a-z0-9]{26}$/;
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const previewId = process.env.PREVIEW_ID || process.argv.slice(2).find((arg) => PREVIEW_ID_RE.test(arg));
if (!previewId) {
  console.error('error: PREVIEW_ID is required (prv_<26 base32 chars>)');
  process.exit(2);
}
if (!PREVIEW_ID_RE.test(previewId)) {
  console.error(`error: invalid preview id ${previewId}`);
  process.exit(2);
}

let store;
try {
  store = createStorage(loadContext().config);
} catch (error) {
  console.error(`error: R2 credentials unavailable: ${error.message}`);
  process.exit(2);
}

const keys = [];
let bytes = 0;
for await (const object of store.list(`previews/${previewId}/`)) {
  keys.push(object.key);
  bytes += object.size || 0;
}

if (!keys.length) {
  console.log(`Preview ${previewId}: nothing to clean`);
  process.exit(0);
}
if (dryRun) {
  console.log(`[dry-run] would delete ${keys.length} object(s) (${bytes} bytes) under previews/${previewId}/`);
  process.exit(0);
}
await store.delete(keys);
console.log(`Cleaned preview ${previewId}: ${keys.length} object(s), ${bytes} bytes`);
