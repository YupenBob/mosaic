/** Preserve existing Pages settings while configuring the shared Worker proxy. */
import { loadContext } from './lib/context.mjs';
const { config } = loadContext();
const account = process.env.CLOUDFLARE_ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN;
const target = process.env.API_TARGET || config.apiBase.replace(/\/api\/?$/, '');
if (!account || !token || !/^https:\/\//.test(target))
  throw new Error('Cloudflare credentials and an absolute API_TARGET are required');
for (const project of [config.deployment.siteProject, config.deployment.adminProject]) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${encodeURIComponent(project)}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const existing = await fetch(url, { headers });
  if (!existing.ok) throw new Error(`Cannot load Pages project ${project}: ${existing.status}`);
  // Pages PATCH merges variable keys; deletion requires an explicit null value.
  // Send only API_TARGET, never round-trip secret values returned by GET.
  const deployment_configs = {};
  for (const environment of ['production', 'preview']) {
    deployment_configs[environment] = { env_vars: { API_TARGET: { type: 'plain_text', value: target } } };
  }
  const updated = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ deployment_configs }) });
  if (!updated.ok || !(await updated.json()).success)
    throw new Error(`Cannot configure Pages proxy ${project}: ${updated.status}`);
  console.log(`Configured Worker proxy for ${project}`);
}
