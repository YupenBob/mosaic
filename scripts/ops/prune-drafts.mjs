/**
 * Prune abandoned cloud drafts from R2 (`drafts/<draftId>/...`).
 *
 * Drafts live in R2 so autosave never pollutes Git. A draft that was not
 * touched for `--days` (default 30) is deleted with all of its revision
 * snapshots; the current record is `current.json` with an `updatedAt` stamp.
 *
 * `--dry-run` (default) prints candidates; `--apply` deletes them.
 */
import { fatal, formatBytes, isApply, loadConfig, log, modeLabel, parseArgs, r2Storage } from './common.mjs';

const PREFIX = 'drafts/';
const DEFAULT_DAYS = 30;
const args = parseArgs();
const apply = isApply(args);
const mode = modeLabel(apply);
const config = loadConfig().config;
const days = Number(args.values.days || process.env.PRUNE_DRAFT_DAYS || DEFAULT_DAYS);
if (!Number.isFinite(days) || days < 1) fatal('--days must be a positive number');
const cutoffMs = Date.now() - days * 86400000;

let store;
try {
  store = await r2Storage(config);
} catch (error) {
  fatal(
    `R2 credentials unavailable: ${error.message}\n  Set R2_ACCESS_KEY, R2_SECRET_KEY and R2_ENDPOINT (or CF_ACCOUNT_ID)`,
  );
}

const drafts = new Map();
for await (const object of store.list(PREFIX)) {
  const id = object.key.slice(PREFIX.length).split('/')[0];
  if (!id) continue;
  const entry = drafts.get(id) || { id, keys: [], bytes: 0, newest: 0 };
  entry.keys.push(object.key);
  entry.bytes += object.size || 0;
  entry.newest = Math.max(entry.newest, new Date(object.uploaded || 0).getTime());
  drafts.set(id, entry);
}

async function updatedAt(id) {
  try {
    const object = await store.get(`${PREFIX}${id}/current.json`);
    if (!object) return null;
    const draft = JSON.parse(await object.text());
    const stamp = Date.parse(draft.updatedAt || draft.createdAt || '');
    return Number.isFinite(stamp) ? stamp : null;
  } catch {
    return null;
  }
}

const stale = [];
for (const draft of drafts.values()) {
  const stamp = (await updatedAt(draft.id)) ?? draft.newest;
  if (stamp <= cutoffMs) stale.push({ ...draft, stamp });
}

console.log(`Drafts in bucket: ${drafts.size} · untouched for > ${days} days: ${stale.length}`);
for (const draft of stale)
  console.log(
    `  ${PREFIX}${draft.id}/ · ${draft.keys.length} object(s) · ${formatBytes(draft.bytes)} · last ${new Date(draft.stamp).toISOString()}`,
  );

if (!stale.length) {
  log(mode, 'nothing to prune');
  process.exit(0);
}
if (!apply) {
  log(
    mode,
    `would delete ${stale.length} draft(s), ${formatBytes(stale.reduce((total, item) => total + item.bytes, 0))}`,
  );
  process.exit(0);
}
await store.delete(stale.flatMap((draft) => draft.keys));
log(mode, `deleted ${stale.length} abandoned draft(s)`);
