/**
 * Garbage-collect immutable manifest snapshots (`site-data/media-manifests/<revision>.json`).
 *
 * A snapshot is deleted only when BOTH hold:
 *   1. no retained deployment, in-flight build or the current manifest revision
 *      references it (references come from the Jobs DO `state` operation), and
 *   2. it is older than 180 days (or --days).
 *
 * The reference check is mandatory: without Worker access this script refuses
 * to delete anything instead of guessing.
 *
 * `--dry-run` (default) prints candidates; `--apply` deletes them.
 */
import { createPipelineClient } from '../lib/pipeline-client.mjs';
import { fatal, formatBytes, isApply, log, modeLabel, parseArgs, r2Storage } from './common.mjs';

const MIN_AGE_DAYS = 180;
const PREFIX = 'site-data/media-manifests/';

const args = parseArgs();
const apply = isApply(args);
const mode = modeLabel(apply);
const days = Number(args.values.days || MIN_AGE_DAYS);
if (!Number.isFinite(days) || days < 1) fatal('--days must be a positive number');

let store;
try {
  store = await r2Storage();
} catch (error) {
  fatal(
    `R2 credentials unavailable: ${error.message}\n  Set R2_ACCESS_KEY, R2_SECRET_KEY and R2_ENDPOINT (or CF_ACCOUNT_ID)`,
  );
}
if (!process.env.API_TARGET || !process.env.PIPELINE_SECRET)
  fatal('API_TARGET and PIPELINE_SECRET are required to check which snapshots are still referenced');

let state;
try {
  state = await createPipelineClient()('state');
} catch (error) {
  fatal(`cannot read the Jobs DO state (reference check is mandatory): ${error.message}`);
}

const referenced = new Set();
if (Number.isFinite(state?.manifest?.revision)) referenced.add(Number(state.manifest.revision));
for (const deployment of state?.deployments || [])
  if (Number.isFinite(deployment.mediaRevision)) referenced.add(Number(deployment.mediaRevision));
for (const build of state?.builds || [])
  if (Number.isFinite(build.mediaRevision)) referenced.add(Number(build.mediaRevision));
console.log(`Referenced revisions: ${[...referenced].sort((a, b) => a - b).join(', ') || '(none)'}`);

const candidates = [];
let kept = 0;
for await (const object of store.list(PREFIX)) {
  const match = /media-manifests\/(\d+)\.json$/.exec(object.key);
  if (!match) continue;
  const revision = Number(match[1]);
  const ageDays = (Date.now() - new Date(object.uploaded).getTime()) / 86400000;
  if (referenced.has(revision)) {
    kept++;
    continue;
  }
  if (!(ageDays > days)) {
    kept++;
    continue;
  }
  candidates.push({ key: object.key, revision, size: object.size, ageDays });
}

console.log(`Snapshots kept: ${kept}`);
console.log(`Snapshots deletable (> ${days} days, unreferenced): ${candidates.length}`);
for (const candidate of candidates)
  console.log(
    `  ${candidate.key} · revision ${candidate.revision} · ${formatBytes(candidate.size)} · ${candidate.ageDays.toFixed(0)}d old`,
  );

if (!candidates.length) {
  log(mode, 'nothing to collect');
  process.exit(0);
}
if (!apply) {
  log(
    mode,
    `would delete ${candidates.length} snapshot(s), ${formatBytes(candidates.reduce((total, item) => total + item.size, 0))}`,
  );
  process.exit(0);
}
await store.delete(candidates.map((candidate) => candidate.key));
log(mode, `deleted ${candidates.length} snapshot(s)`);
