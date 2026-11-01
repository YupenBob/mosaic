/**
 * Zone WAF custom rule for the public media domain: only `/processed/`,
 * `/originals/` and `/site-data/favicon.*` stay reachable; every other R2 path
 * (manifests, site caches, drafts, previews, migration markers) is blocked.
 *
 * Idempotent and non-destructive: existing custom rules in the zone ruleset are
 * preserved, only the rule owned by Mosaic (matched by description) is replaced
 * with the desired expression. `--dry-run` prints the diff without writing.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... node scripts/ops/secure-media-domain.mjs --dry-run
 *   node scripts/ops/secure-media-domain.mjs --apply
 */
import { cloudflareJson, fatal, isApply, loadConfig, log, modeLabel, parseArgs } from './common.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const RULE_DESCRIPTION = 'Mosaic: media domain exposure allowlist';
const ALLOWED_PREFIXES = ['/processed/', '/originals/', '/site-data/favicon.'];

const args = parseArgs();
const apply = isApply(args);
const mode = modeLabel(apply);
const config = loadConfig().config;

const mediaHost = (process.env.MEDIA_ORIGIN || process.env.MEDIA_URL || config.mediaBase || '')
  .replace(/^https?:\/\//, '')
  .replace(/\/.*$/, '')
  .replace(/:\d+$/, '');
if (!mediaHost) fatal('MEDIA_ORIGIN, MEDIA_URL or mediaBase must identify the media domain');

const expression =
  `(http.host eq "${mediaHost}" and not (` +
  ALLOWED_PREFIXES.map((prefix) => `starts_with(http.request.uri.path, "${prefix}")`).join(' or ') +
  '))';
const desiredRule = { description: RULE_DESCRIPTION, expression, action: 'block', enabled: true };

const sanitize = (rule) => ({
  description: rule.description,
  expression: rule.expression,
  action: rule.action,
  enabled: rule.enabled !== false,
});

console.log(`Media host: ${mediaHost}`);
console.log(`Allowlist:  ${ALLOWED_PREFIXES.join(' ')}`);
console.log(`Expression: ${expression}`);

const zone = process.env.CLOUDFLARE_ZONE_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;

/** @returns {Promise<{ruleset: object|null, merged: object[], changed: boolean}>} */
async function plan() {
  // Local dry-runs stay meaningful without credentials: show the desired rule.
  if (!zone || !token) {
    if (apply)
      fatal(
        `${!zone ? 'CLOUDFLARE_ZONE_ID' : 'CLOUDFLARE_API_TOKEN'} is required to apply the WAF rule (set both for --apply)`,
      );
    log(
      mode,
      `no ${!zone ? 'CLOUDFLARE_ZONE_ID' : 'CLOUDFLARE_API_TOKEN'}: showing the desired rule only, existing ruleset not merged`,
    );
    return { ruleset: null, merged: [desiredRule], changed: true, unverified: true };
  }
  const base = `${API}/zones/${encodeURIComponent(zone)}/rulesets`;
  const entry = await cloudflareJson({
    token,
    url: `${base}/phases/http_request_firewall_custom/entrypoint`,
    allow404: true,
  });
  const ruleset = entry.ok ? entry.data?.result || null : null;
  const existing = ruleset?.rules || [];
  const ours = existing.filter((rule) => rule.description === RULE_DESCRIPTION);
  const others = existing.filter((rule) => rule.description !== RULE_DESCRIPTION);
  const unchanged = ours.length === 1 && JSON.stringify(sanitize(ours[0])) === JSON.stringify(sanitize(desiredRule));
  const merged = [...others, desiredRule];
  return { ruleset, merged, changed: !unchanged, unverified: false, existingCount: existing.length };
}

let planResult;
try {
  planResult = await plan();
} catch (error) {
  fatal(`cannot read the zone WAF ruleset: ${error.message}`, 1);
}
const { ruleset, merged, changed, unverified } = planResult;
if (!changed) {
  log(mode, 'zone WAF ruleset already contains the desired Mosaic rule (no-op)');
  process.exit(0);
}

log(mode, `rule count: ${ruleset?.rules?.length || 0} -> ${merged.length}${unverified ? ' (unverified)' : ''}`);
log(mode, `would block: every ${mediaHost} path outside ${ALLOWED_PREFIXES.join(', ')}`);

if (!apply) {
  log(mode, 'pass --apply to write the rule');
  process.exit(0);
}

try {
  const base = `${API}/zones/${encodeURIComponent(zone)}/rulesets`;
  if (ruleset?.id) {
    const { data } = await cloudflareJson({
      token,
      url: `${base}/${encodeURIComponent(ruleset.id)}`,
      method: 'PUT',
      body: {
        ...(ruleset.name ? { name: ruleset.name } : {}),
        ...(ruleset.description ? { description: ruleset.description } : {}),
        kind: ruleset.kind || 'zone',
        phase: ruleset.phase || 'http_request_firewall_custom',
        rules: merged,
      },
    });
    console.log(`Updated zone WAF ruleset ${data?.result?.id || ruleset.id} with ${merged.length} rule(s)`);
  } else {
    const { data } = await cloudflareJson({
      token,
      url: base,
      method: 'POST',
      body: {
        name: 'Mosaic media domain allowlist',
        description: 'Created by scripts/ops/secure-media-domain.mjs',
        kind: 'zone',
        phase: 'http_request_firewall_custom',
        rules: merged,
      },
    });
    console.log(`Created zone WAF ruleset ${data?.result?.id} with ${merged.length} rule(s)`);
  }
} catch (error) {
  fatal(`WAF ruleset update failed: ${error.message}`, 1);
}
log(mode, `media domain locked down; purging cached site-data URLs is handled by scripts/ops/purge-site-data.mjs`);
