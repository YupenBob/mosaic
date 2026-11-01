/**
 * Roll the production Cloudflare Pages deployment back to a previous
 * successful build. Dry-run by default: it prints the current and target
 * deployments and only calls the rollback endpoint with `--apply`.
 *
 * Usage:
 *   node scripts/ops/rollback.mjs                       # dry-run, previous success
 *   node scripts/ops/rollback.mjs --deployment <id>     # dry-run, explicit target
 *   node scripts/ops/rollback.mjs --apply [--deployment <id>]
 */
import { cloudflareAccount, cloudflareJson, fatal, loadConfig, log, modeLabel, parseArgs } from './common.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const args = parseArgs();
const apply = args.flags.has('apply');
const mode = modeLabel(apply);
const config = loadConfig().config;
const project = args.values.project || process.env.SITE_PROJECT || config.deployment.siteProject;
const requested = args.values.deployment;
let token, account;
try {
  ({ token, account } = cloudflareAccount());
} catch (error) {
  fatal(error.message, 2);
}

const statusOf = (deployment) => deployment?.latest_stage?.status || deployment?.status || 'unknown';
const describe = (deployment) =>
  `${deployment.id} · ${statusOf(deployment)} · ${deployment.created_on} · ${deployment.url}` +
  (deployment.deployment_trigger?.metadata?.commit_hash
    ? ` · ${deployment.deployment_trigger.metadata.commit_hash.slice(0, 7)}`
    : '');

async function listDeployments() {
  const url = `${API}/accounts/${account}/pages/projects/${encodeURIComponent(project)}/deployments?env=production&per_page=20`;
  const { data } = await cloudflareJson({ token, url });
  return data?.result || [];
}

let deployments;
try {
  deployments = await listDeployments();
} catch (error) {
  fatal(`cannot list Pages deployments for ${project}: ${error.message}`, 1);
}
if (!deployments.length) fatal(`no production deployments found for Pages project ${project}`, 1);

const current = deployments[0];
let target;
if (requested) {
  target = deployments.find((deployment) => deployment.id === requested || deployment.id.startsWith(requested)) || null;
  if (!target) {
    // The requested deployment may be older than the listing window.
    try {
      const { data } = await cloudflareJson({
        token,
        url: `${API}/accounts/${account}/pages/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(requested)}`,
      });
      target = data?.result || null;
    } catch (error) {
      fatal(`deployment ${requested} not found in ${project}: ${error.message}`, 1);
    }
  }
} else {
  target = deployments.slice(1).find((deployment) => statusOf(deployment) === 'success') || null;
  if (!target) fatal(`no previous successful deployment to roll back to in ${project}`, 1);
}

console.log(`Project: ${project}`);
console.log(`Current: ${describe(current)}`);
console.log(`Target:  ${describe(target)}`);
if (target.id === current.id) fatal('target deployment is already production; nothing to roll back', 1);

const endpoint = `${API}/accounts/${account}/pages/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(target.id)}/rollback`;
if (!apply) {
  log(mode, `would POST ${endpoint}`);
  log(mode, 'pass --apply to perform the rollback');
  process.exit(0);
}

let created;
try {
  const { data } = await cloudflareJson({ token, url: endpoint, method: 'POST', body: {} });
  created = data?.result;
} catch (error) {
  fatal(`rollback failed: ${error.message}`, 1);
}
if (!created?.id) fatal('rollback API returned no deployment', 1);
console.log(`Rolled back: ${created.id} · ${created.url || ''}`);
