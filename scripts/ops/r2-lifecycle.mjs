/**
 * Bucket lifecycle policy for the media R2 bucket:
 *   - `previews/` expires after 14 days (private previews are throwaway)
 *   - incomplete multipart uploads abort after 2 days (stale uploads otherwise
 *     bill storage forever)
 *
 * Merge semantics: rules not owned by Mosaic are preserved, Mosaic rules are
 * replaced by id. Idempotent: an already-matching policy is a no-op.
 *
 * `--dry-run` (default) prints the plan; `--apply` writes it.
 *
 * Usage:
 *   node scripts/ops/r2-lifecycle.mjs            # dry-run
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/ops/r2-lifecycle.mjs --apply
 */
import { cloudflareAccount, cloudflareJson, fatal, isApply, loadConfig, log, modeLabel, parseArgs } from './common.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const PREVIEW_EXPIRY_DAYS = 14;
const ABORT_INCOMPLETE_DAYS = 2;
const OWNED_PREFIX = 'mosaic-';

const args = parseArgs();
const apply = isApply(args);
const mode = modeLabel(apply);
const config = loadConfig().config;
const bucket = args.values.bucket || process.env.R2_BUCKET || config.mediaSource.bucket;
if (!bucket) fatal('R2_BUCKET or mediaSource.bucket is required');

const desired = [
  {
    id: 'mosaic-previews-expire',
    enabled: true,
    conditions: { prefix: 'previews/' },
    deleteObjects: { maxAgeDays: PREVIEW_EXPIRY_DAYS },
  },
  {
    id: 'mosaic-abort-incomplete-multipart',
    enabled: true,
    conditions: {},
    abortMultipartUploads: { maxAgeDays: ABORT_INCOMPLETE_DAYS },
  },
];

const lifecycleUrl = (account) =>
  `${API}/accounts/${encodeURIComponent(account)}/r2/buckets/${encodeURIComponent(bucket)}/lifecycle`;

async function plan() {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    if (apply) fatal('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to update the lifecycle policy');
    log(mode, 'no Cloudflare credentials: showing the desired policy only, existing rules not merged');
    return { existing: [], merged: desired, changed: true, unverified: true };
  }
  const { token, account } = cloudflareAccount();
  const response = await cloudflareJson({ token, url: lifecycleUrl(account), allow404: true });
  const existing = response.ok ? response.data?.result?.rules || [] : [];
  const others = existing.filter((rule) => !String(rule.id || '').startsWith(OWNED_PREFIX));
  const merged = [...others, ...desired];
  const unchanged =
    existing.length === merged.length &&
    JSON.stringify(existing.slice().sort(byId)) === JSON.stringify(merged.slice().sort(byId));
  return { existing, merged, changed: !unchanged, unverified: false, token, account };
}

const byId = (a, b) => String(a.id).localeCompare(String(b.id));

const { existing, merged, changed, unverified, token, account } = await plan();
console.log(`Bucket: ${bucket} (${merged.length} rule(s), ${existing.length} existing)`);
for (const rule of merged) {
  const action = rule.deleteObjects
    ? `delete after ${rule.deleteObjects.maxAgeDays}d`
    : rule.abortMultipartUploads
      ? `abort incomplete multipart after ${rule.abortMultipartUploads.maxAgeDays}d`
      : 'unknown';
  console.log(`  ${rule.id}: ${action}${rule.conditions?.prefix ? ` (prefix ${rule.conditions.prefix})` : ''}`);
}
if (!changed) {
  log(mode, 'lifecycle policy already matches (no-op)');
  process.exit(0);
}
if (!apply) {
  log(
    mode,
    unverified ? 'pass --apply to write the policy (credentials required)' : 'pass --apply to write the policy',
  );
  process.exit(0);
}

const { data } = await cloudflareJson({
  token,
  url: lifecycleUrl(account),
  method: 'PUT',
  body: { rules: merged },
});
if (data?.success === false) fatal(`lifecycle update failed: ${JSON.stringify(data.errors)}`, 1);
log(mode, `lifecycle policy written for ${bucket}`);
