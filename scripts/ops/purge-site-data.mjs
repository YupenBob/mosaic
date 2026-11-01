/**
 * Purge the Cloudflare edge cache for the `site-data/*` objects of the media
 * domain. Needed once when the media-domain WAF allowlist is enabled (edge
 * caches may still hold the previously public manifest/site caches) and after
 * a migration marker changes.
 *
 * `--dry-run` (default) prints the URL list; `--apply` calls purge_cache.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... node scripts/ops/purge-site-data.mjs
 *   node scripts/ops/purge-site-data.mjs --apply --url https://media.example/site-data/x.json
 */
import { cloudflareJson, fatal, isApply, loadConfig, mediaOrigin, modeLabel, parseArgs } from './common.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const DEFAULT_FILES = [
  'site-data/media-manifest.json',
  'site-data/posts-index.json',
  'site-data/categories.json',
  'site-data/tags.json',
  'site-data/media-migration-v1.json',
  'site-data/media-v2-migration.json',
];

const args = parseArgs();
const apply = isApply(args);
const mode = modeLabel(apply);
const config = loadConfig().config;
const origin = mediaOrigin(config);
const files = [args.values.url, ...(args.values.files ? String(args.values.files).split(',') : []), ...DEFAULT_FILES]
  .filter(Boolean)
  .map((entry) => (entry.startsWith('http') ? entry : `${origin}/${entry.replace(/^\/+/, '')}`))
  .filter((entry, index, all) => all.indexOf(entry) === index);

console.log(`Purging ${files.length} URL(s) on ${origin}`);
for (const file of files) console.log(`  ${file}`);

if (!apply) {
  console.log(`[${mode}] pass --apply to purge these URLs`);
  process.exit(0);
}

const zone = process.env.CLOUDFLARE_ZONE_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!zone || !token) fatal('CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN are required to purge the cache');

// Single-file purges are capped at 30 URLs per request.
for (let offset = 0; offset < files.length; offset += 30) {
  const batch = files.slice(offset, offset + 30);
  const { data } = await cloudflareJson({
    token,
    url: `${API}/zones/${encodeURIComponent(zone)}/purge_cache`,
    method: 'POST',
    body: { files: batch },
  });
  if (data?.success === false) fatal(`purge failed: ${JSON.stringify(data.errors)}`, 1);
  console.log(`Purged ${batch.length} URL(s)`);
}
console.log(`[${mode}] site-data cache purged`);
