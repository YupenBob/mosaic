/**
 * Read-only pre-flight check for a production rollout.
 *
 * Reads local operator credentials from `.secrets/` (never printed) and asserts
 * that the accounts, permissions and bucket access needed by the workflows are
 * actually in place before enabling deploys:
 *
 *   1. GitHub token valid and able to push to the configured repository
 *   2. Cloudflare token valid
 *   3. Zone readable
 *   4. Zone WAF custom-rules entrypoint readable (403 = missing WAF permission,
 *      reported as a warning so it never masks the other checks)
 *   5. R2 HeadObject for the media manifest (skipped when R2_* is not exported)
 *
 * Usage:
 *   node scripts/ops/preflight.mjs
 *   node scripts/ops/preflight.mjs --json     # machine-readable, for CI/operators
 *
 * Exit codes: 0 all required checks passed, 1 a required check failed,
 * 2 credentials/secrets are missing or unusable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRETS_DIR = path.join(ROOT, '.secrets');
const JSON_OUTPUT = process.argv.includes('--json');
const API = 'https://api.cloudflare.com/client/v4';
const GITHUB_API = 'https://api.github.com';
const MANIFEST_KEY = 'site-data/media-manifest.json';

const SECRET_FILES = {
  githubToken: 'github_token',
  cloudflareToken: 'cloudflare_token',
  accountId: 'cloudflare_account_id',
  zoneId: 'cloudflare_zone_id',
};

function readSecret(name) {
  const file = path.join(SECRETS_DIR, name);
  if (!fs.existsSync(file)) return null;
  const value = fs.readFileSync(file, 'utf8').trim();
  return value || null;
}

function fatal(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

if (!fs.existsSync(SECRETS_DIR))
  fatal(`missing ${SECRETS_DIR}/ (create it with ${Object.values(SECRET_FILES).join(', ')})`);
const secrets = Object.fromEntries(Object.entries(SECRET_FILES).map(([key, file]) => [key, readSecret(file)]));
const missing = Object.entries(SECRET_FILES)
  .filter(([key]) => !secrets[key])
  .map(([, file]) => file);
if (missing.length) fatal(`missing secret file(s) in .secrets/: ${missing.join(', ')}`);

const repo = (process.env.GITHUB_REPO || 'YupenBob/Mosaic').replace(/^\/+|\/+$/g, '');
const checks = [];
function record(name, status, detail = '') {
  checks.push({ name, status, detail });
  if (JSON_OUTPUT) return;
  const label = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL';
  console.log(`  ${label} ${name}${detail ? `: ${detail}` : ''}`);
}

async function call(url, { token, method = 'GET', headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Mosaic-Preflight/1.0',
      'Content-Type': 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

// ── 1. GitHub identity + repository write permission ──
try {
  const user = await call(`${GITHUB_API}/user`, { token: secrets.githubToken });
  if (user.response.status !== 200) throw new Error(`GET /user -> ${user.response.status}`);
  const repository = await call(`${GITHUB_API}/repos/${repo}`, { token: secrets.githubToken });
  if (repository.response.status !== 200) throw new Error(`GET /repos/${repo} -> ${repository.response.status}`);
  if (repository.body?.permissions?.push !== true)
    throw new Error(`token cannot push to ${repo} (permissions.push is false)`);
  record('GitHub token', 'pass', `${user.body?.login} can push to ${repo}`);
} catch (error) {
  record('GitHub token', 'fail', error.message);
}

// ── 2. Cloudflare token ──
try {
  const verify = await call(`${API}/user/tokens/verify`, { token: secrets.cloudflareToken });
  if (verify.response.status !== 200 || verify.body?.success !== true)
    throw new Error(
      `/user/tokens/verify -> ${verify.response.status} ${JSON.stringify(verify.body?.errors || '').slice(0, 160)}`,
    );
  record('Cloudflare token', 'pass', verify.body?.result?.status || 'active');
} catch (error) {
  record('Cloudflare token', 'fail', error.message);
}

// ── 3. Zone readable ──
try {
  const zone = await call(`${API}/zones/${encodeURIComponent(secrets.zoneId)}`, { token: secrets.cloudflareToken });
  if (zone.response.status !== 200 || zone.body?.success !== true)
    throw new Error(`GET /zones/{zone} -> ${zone.response.status}`);
  record('Cloudflare zone', 'pass', zone.body?.result?.name || secrets.zoneId);
} catch (error) {
  record('Cloudflare zone', 'fail', error.message);
}

// ── 4. WAF custom rules entrypoint (permission may be missing) ──
try {
  const entry = await call(
    `${API}/zones/${encodeURIComponent(secrets.zoneId)}/rulesets/phases/http_request_firewall_custom/entrypoint`,
    { token: secrets.cloudflareToken },
  );
  if (entry.response.status === 403) record('Zone WAF ruleset', 'warn', 'HTTP 403: token lacks WAF read permission');
  else if (entry.response.status === 404) record('Zone WAF ruleset', 'pass', 'no entrypoint yet (will be created)');
  else if (entry.response.status !== 200)
    record('Zone WAF ruleset', 'warn', `GET entrypoint -> ${entry.response.status}`);
  else {
    const count = entry.body?.result?.rules?.length || 0;
    record('Zone WAF ruleset', 'pass', `entrypoint exists with ${count} custom rule(s)`);
  }
} catch (error) {
  record('Zone WAF ruleset', 'warn', error.message);
}

// ── 5. R2 object access (optional: needs the S3 credentials exported) ──
const r2 = {
  accessKey: process.env.R2_ACCESS_KEY,
  secretKey: process.env.R2_SECRET_KEY,
  endpoint:
    process.env.R2_ENDPOINT ||
    (process.env.CF_ACCOUNT_ID ? `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com` : ''),
};
if (!r2.accessKey || !r2.secretKey || !r2.endpoint) {
  record(
    'R2 media manifest',
    'warn',
    'skipped: export R2_ACCESS_KEY, R2_SECRET_KEY and R2_ENDPOINT (or CF_ACCOUNT_ID)',
  );
} else {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'mosaic.config.json'), 'utf8'));
    const bucket = process.env.R2_BUCKET || config.mediaSource?.bucket;
    if (!bucket) throw new Error('mediaSource.bucket missing from mosaic.config.json');
    const client = new S3Client({
      region: 'auto',
      endpoint: r2.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: r2.accessKey, secretAccessKey: r2.secretKey },
    });
    try {
      const object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: MANIFEST_KEY }));
      record('R2 media manifest', 'pass', `${bucket}/${MANIFEST_KEY} (${object.ContentLength} bytes)`);
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 404)
        record('R2 media manifest', 'warn', `${bucket}/${MANIFEST_KEY} not found (site not initialized yet)`);
      else throw error;
    }
  } catch (error) {
    record('R2 media manifest', 'fail', error.message);
  }
}

const summary = {
  pass: checks.filter((check) => check.status === 'pass').length,
  warn: checks.filter((check) => check.status === 'warn').length,
  fail: checks.filter((check) => check.status === 'fail').length,
};

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), repo, checks, summary }, null, 2));
} else {
  console.log(`\n${summary.pass} passed, ${summary.warn} warnings, ${summary.fail} failed`);
}
process.exit(summary.fail ? 1 : 0);
