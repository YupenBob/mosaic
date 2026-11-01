/**
 * Deploy `dist/` to Cloudflare Pages with bounded retries and a recorded
 * deployment id.
 *
 * Replaces `cloudflare/wrangler-action` so the deploy command, retry policy and
 * the deployment record are versioned in this repository instead of an external
 * action's input surface. A transient Pages/network failure retries with
 * 15s/45s/120s backoff before the content build is considered failed.
 *
 * Usage (pipeline.yml):
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... SITE_PROJECT=mosaic \
 *   SITE_BRANCH=main node scripts/ops/deploy-pages.mjs
 *
 *   node scripts/ops/deploy-pages.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEPLOY_RECORD_PATH, PAGES_DEPLOY_BACKOFF_MS, PAGES_DEPLOY_MAX_ATTEMPTS } from '../../shared/deployment.mjs';
import { ROOT, cloudflareJson, fatal, loadConfig, log, modeLabel, parseArgs } from './common.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const args = parseArgs();
const dryRun = args.flags.has('dry-run');
const mode = modeLabel(!dryRun);
const config = loadConfig().config;
// ENV wins (written by scripts/deployment-env.mjs); config is the local default.
const project = process.env.SITE_PROJECT || config.deployment.siteProject;
const branch = process.env.SITE_BRANCH || config.deployment.branch;
const directory = args.values.directory || 'dist';

if (!project) fatal('SITE_PROJECT is required (read via scripts/deployment-env.mjs)');
if (!branch) fatal('SITE_BRANCH is required');
const command = [
  'exec',
  '--prefix',
  'worker',
  '--',
  'wrangler',
  'pages',
  'deploy',
  directory,
  '--project-name',
  project,
  '--branch',
  branch,
  '--commit-dirty=true',
];

if (dryRun) {
  log(mode, `would run: npm ${command.join(' ')}`);
  log(
    mode,
    `retry policy: ${PAGES_DEPLOY_MAX_ATTEMPTS} attempts, backoff ${PAGES_DEPLOY_BACKOFF_MS.map((ms) => `${ms / 1000}s`).join('/')}`,
  );
  log(mode, `would record deployment id into ${DEPLOY_RECORD_PATH}`);
  process.exit(0);
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) fatal('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to deploy');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deployOnce() {
  const result = spawnSync('npm', command, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error) console.error(`wrangler spawn failed: ${result.error.message}`);
  return result.status === 0;
}

const startedAt = Date.now();
let deployed = false;
let attempts = 0;
for (let attempt = 1; attempt <= PAGES_DEPLOY_MAX_ATTEMPTS; attempt++) {
  attempts = attempt;
  log(mode, `Pages deploy attempt ${attempt}/${PAGES_DEPLOY_MAX_ATTEMPTS} (${project}@${branch})`);
  if (deployOnce()) {
    deployed = true;
    break;
  }
  const backoff = PAGES_DEPLOY_BACKOFF_MS[attempt - 1];
  if (backoff === undefined) break;
  log('retry', `deploy failed, retrying in ${backoff / 1000}s`);
  await sleep(backoff);
}
if (!deployed) {
  console.error(`Pages deploy failed after ${PAGES_DEPLOY_MAX_ATTEMPTS} attempts`);
  process.exit(1);
}

/** Query the project for the deployment this run created. Best effort: never fails the build. */
async function recordDeployment() {
  try {
    const url = `${API}/accounts/${account}/pages/projects/${encodeURIComponent(project)}/deployments?env=production&per_page=10`;
    const { data } = await cloudflareJson({ token, url });
    const deployments = data?.result || [];
    const fresh = deployments
      .filter((deployment) => Date.parse(deployment.created_on || 0) >= startedAt - 60000)
      .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
    const deployment = fresh[0] || deployments[0];
    if (!deployment) {
      console.warn('warn: no Pages deployment returned by the API; deployment id not recorded');
      return null;
    }
    const record = {
      project,
      environment: deployment.environment || 'production',
      branch,
      deploymentId: deployment.id,
      url: deployment.url,
      commitHash: deployment.deployment_trigger?.metadata?.commit_hash || '',
      attempts,
      recordedAt: new Date().toISOString(),
    };
    const file = path.join(ROOT, DEPLOY_RECORD_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Pages deployment ${record.deploymentId} -> ${record.url}`);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `deployment_id=${record.deploymentId}\ndeployment_url=${record.url}\n`,
      );
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Cloudflare Pages deploy\n\n- project: \`${record.project}\`\n- deployment: \`${record.deploymentId}\`\n- url: ${record.url}\n`,
      );
    }
    return record;
  } catch (error) {
    console.warn(`warn: could not record the Pages deployment id: ${error.message}`);
    return null;
  }
}

const record = await recordDeployment();
console.log(record ? `Deployment recorded: ${record.deploymentId}` : 'Deployment succeeded (id not recorded)');
