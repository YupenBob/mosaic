/**
 * Prune expired private previews from R2 (`previews/<previewId>/...`).
 *
 * The Worker writes `previews/<id>/meta.json` with a TTL (`preview.ttlHours`),
 * so the meta record is authoritative: a preview is deleted when its
 * `expiresAt` passed and it is not currently queued/building. Previews without
 * meta fall back to the age of their newest object.
 *
 * `--dry-run` (default) prints candidates; `--apply` deletes them.
 */
import { fatal, formatBytes, isApply, loadConfig, log, modeLabel, parseArgs, r2Storage } from './common.mjs';

const PREFIX = 'previews/';
const ACTIVE_STATUSES = ['queued', 'building', 'running'];
const args = parseArgs();
const apply = isApply(args);
const mode = modeLabel(apply);
const config = loadConfig().config;
const ttlHours = Number(
  args.values['max-age-hours'] || process.env.PREVIEW_MAX_AGE_HOURS || config.preview?.ttlHours || 24,
);
if (!Number.isFinite(ttlHours) || ttlHours < 1) fatal('--max-age-hours must be a positive number');
const ttlMs = ttlHours * 3600000;

let store;
try {
  store = await r2Storage(config);
} catch (error) {
  fatal(
    `R2 credentials unavailable: ${error.message}\n  Set R2_ACCESS_KEY, R2_SECRET_KEY and R2_ENDPOINT (or CF_ACCOUNT_ID)`,
  );
}

async function readMeta(id) {
  try {
    const object = await store.get(`${PREFIX}${id}/meta.json`);
    return object ? JSON.parse(await object.text()) : null;
  } catch {
    return null;
  }
}

const previews = new Map();
for await (const object of store.list(PREFIX)) {
  const id = object.key.slice(PREFIX.length).split('/')[0];
  if (!id) continue;
  const entry = previews.get(id) || { id, keys: [], bytes: 0, newest: 0 };
  entry.keys.push(object.key);
  entry.bytes += object.size || 0;
  entry.newest = Math.max(entry.newest, new Date(object.uploaded || 0).getTime());
  previews.set(id, entry);
}

const expired = [];
const skipped = [];
for (const preview of previews.values()) {
  const meta = await readMeta(preview.id);
  if (meta && ACTIVE_STATUSES.includes(meta.status)) {
    skipped.push({ ...preview, reason: `status ${meta.status}` });
    continue;
  }
  // The meta TTL is authoritative when present; age is only a fallback for
  // legacy/hand-made prefixes.
  const expiresAt = meta?.expiresAt ? Date.parse(meta.expiresAt) : NaN;
  const isExpired = meta ? Number.isFinite(expiresAt) && Date.now() > expiresAt : Date.now() - preview.newest > ttlMs;
  if (isExpired) expired.push(preview);
  else
    skipped.push({
      ...preview,
      reason: meta ? `expires ${meta.expiresAt}` : `newest ${Math.round((Date.now() - preview.newest) / 3600000)}h old`,
    });
}

console.log(`Previews in bucket: ${previews.size} · expired: ${expired.length} · skipped: ${skipped.length}`);
for (const preview of expired)
  console.log(`  previews/${preview.id}/ · ${preview.keys.length} object(s) · ${formatBytes(preview.bytes)}`);
for (const preview of skipped) console.log(`  skip previews/${preview.id}/ (${preview.reason})`);

if (!expired.length) {
  log(mode, 'nothing to prune');
  process.exit(0);
}
if (!apply) {
  log(
    mode,
    `would delete ${expired.length} preview(s), ${formatBytes(expired.reduce((total, item) => total + item.bytes, 0))}`,
  );
  process.exit(0);
}
await store.delete(expired.flatMap((preview) => preview.keys));
log(mode, `deleted ${expired.length} expired preview(s)`);
