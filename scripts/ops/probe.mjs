/**
 * Zero-dependency production probe.
 *
 * Runs every 3 hours from `.github/workflows/probe.yml` (no `npm ci`): only
 * Node's built-in `fetch` is used, so the workflow finishes in well under a
 * minute and never depends on the dependency tree.
 *
 * Checks:
 *   - Worker health + real GitHub/R2 dependency probes
 *   - deployed `build-snapshot.json` freshness (build age, git SHA)
 *   - real processed media CORS (discovered from the live site, not hardcoded)
 *   - HLS segment Range request returns 206
 *   - private R2 prefixes answer 403/404 (strict mode fails on 200)
 *   - protected Worker routes reject anonymous callers
 *   - admin panel serves its shell
 *
 * A failure opens (or comments on) a single `ops-alert` issue so monitoring is
 * actionable without a pager integration.
 *
 * Usage:
 *   node scripts/ops/probe.mjs            # human output
 *   node scripts/ops/probe.mjs --json     # machine output + step summary
 *   node scripts/ops/probe.mjs --dry-run  # list planned probes, no network
 */
import fs from 'node:fs';

const JSON_OUTPUT = process.argv.includes('--json');
const DRY_RUN = process.argv.includes('--dry-run');

const config = {
  site: (process.env.SITE_URL || 'https://mosaic.xsanye.cn').replace(/\/+$/, ''),
  api: (process.env.API_URL || 'https://mosaic-api.xsanye.cn').replace(/\/+$/, ''),
  media: (process.env.MEDIA_URL || 'https://mosaic-media.xsanye.cn').replace(/\/+$/, ''),
  admin: (process.env.ADMIN_URL || 'https://mosaic-admin.xsanye.cn').replace(/\/+$/, ''),
  strictPrivate: process.env.PROBE_STRICT_PRIVATE === '1',
  maxBuildAgeHours: Number(process.env.PROBE_MAX_BUILD_AGE_HOURS || 168),
  timeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 10000),
};

const PRIVATE_PATHS = [
  'site-data/media-manifest.json',
  'site-data/posts-index.json',
  'site-data/media-v2-migration.json',
  'previews/',
  'drafts/',
  'site-data/media-manifests/1.json',
];

const PROTECTED_ROUTES = [
  { name: 'GET /api/build/status', method: 'GET', path: '/api/build/status' },
  { name: 'GET /api/media-jobs', method: 'GET', path: '/api/media-jobs' },
  { name: 'POST /api/internal/site/state', method: 'POST', path: '/api/internal/site/state' },
];

const PLAN = [
  `GET ${config.api}/api/health`,
  `GET ${config.api}/api/health/github`,
  `GET ${config.api}/api/health/r2`,
  `GET ${config.site}/build-snapshot.json`,
  `GET ${config.site}/`,
  `discover media URL from sitemap/posts, assert 200 + CORS on a processed asset`,
  `discover HLS playlist, assert a segment Range request returns 206`,
  ...PRIVATE_PATHS.map((path) => `GET ${config.media}/${path} -> 403/404 expected`),
  ...PROTECTED_ROUTES.map((route) => `${route.method} ${config.api}${route.path} -> 401/403 expected`),
  `GET ${config.admin}/`,
];

if (DRY_RUN) {
  console.log(`Probe plan for ${config.site} (dry-run, no network):`);
  for (const step of PLAN) console.log(`  - ${step}`);
  console.log(`strict private prefixes: ${config.strictPrivate}`);
  console.log(`max build age: ${config.maxBuildAgeHours}h`);
  process.exit(0);
}

const checks = [];
function record(name, status, detail = '') {
  checks.push({ name, status, detail });
  if (JSON_OUTPUT) return;
  const label = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL';
  console.log(`  ${label} ${name}${detail ? `: ${detail}` : ''}`);
}

async function fetchChecked(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    ...options,
    headers: { 'User-Agent': 'Mosaic-Probe/1.0', ...(options.headers || {}) },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  return response;
}

async function check(name, run) {
  try {
    const result = await run();
    // A check may downgrade itself to a warning (e.g. warn-only private prefixes).
    if (result && typeof result === 'object' && result.status) record(name, result.status, result.detail || '');
    else record(name, 'pass', result || '');
  } catch (error) {
    record(name, 'fail', error.message);
  }
}

// ── Worker health ──
async function checkHealth() {
  const response = await fetchChecked(`${config.api}/api/health`);
  if (!response.ok) throw new Error(`http ${response.status}`);
  const body = await response.json();
  if (body.status !== 'ok') throw new Error(`status=${body.status}`);
  return `v${body.version || '?'}`;
}

async function checkDependency(name) {
  const response = await fetchChecked(`${config.api}/api/health/${name}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status !== 'ok') throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 140)}`);
  return `${body.latency}ms`;
}

// ── Deployed build snapshot ──
async function checkBuildSnapshot() {
  const response = await fetchChecked(`${config.site}/build-snapshot.json`);
  if (!response.ok) throw new Error(`http ${response.status}`);
  const snapshot = await response.json();
  if (!snapshot.generatedAt) throw new Error('generatedAt missing');
  const generated = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generated)) throw new Error(`invalid generatedAt ${snapshot.generatedAt}`);
  const ageHours = (Date.now() - generated) / 3600000;
  if (ageHours < -1) throw new Error(`generatedAt is in the future (${snapshot.generatedAt})`);
  if (ageHours > config.maxBuildAgeHours)
    throw new Error(`build is ${ageHours.toFixed(1)}h old (> ${config.maxBuildAgeHours}h)`);
  if (snapshot.gitSha && !/^[0-9a-f]{7,40}$/i.test(snapshot.gitSha))
    throw new Error(`invalid gitSha ${snapshot.gitSha}`);
  return `age ${ageHours.toFixed(1)}h, media r${snapshot.mediaRevision ?? '?'}, ${String(snapshot.gitSha || '').slice(0, 7) || 'no sha'}`;
}

async function checkHomepage() {
  const response = await fetchChecked(`${config.site}/`);
  if (!response.ok) throw new Error(`http ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (!/text\/html/.test(type)) throw new Error(`content-type ${type}`);
  const body = await response.text();
  if (body.length < 1000) throw new Error(`suspiciously small body (${body.length} bytes)`);
  return `${body.length} bytes`;
}

// ── Real processed media: discover from the live site ──
const mediaOrigin = config.media;
function absolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return '';
  }
}

function extractMediaUrls(html, pageUrl) {
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href|data-src|poster)="([^"]+)"/g)) {
    const url = absolute(match[1].replace(/&amp;/g, '&'), pageUrl);
    if (url && url.startsWith(`${mediaOrigin}/`)) urls.add(url);
  }
  return [...urls];
}

async function discoverMedia() {
  const pages = [];
  try {
    const sitemap = await fetchChecked(`${config.site}/sitemap.xml`);
    if (sitemap.ok) {
      const xml = await sitemap.text();
      for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const url = match[1];
        if (url.includes('/posts/')) pages.push(url);
        if (pages.length >= 3) break;
      }
    }
  } catch {}
  pages.push(`${config.site}/`);
  const images = [];
  const playlists = [];
  for (const page of pages) {
    try {
      const response = await fetchChecked(page);
      if (!response.ok) continue;
      for (const url of extractMediaUrls(await response.text(), page)) {
        if (/\.m3u8(\?|$)/.test(url)) playlists.push(url);
        else if (/\.(?:jpe?g|png|webp|avif|gif|mp4|webm|mp3|m4a)(?:\?|$)/i.test(url)) images.push(url);
      }
    } catch {}
    if (images.length && playlists.length) break;
  }
  return { images, playlists };
}

async function checkMediaCors(discovered) {
  if (!discovered.images.length) return 'skipped: no processed media URL on the live pages';
  const url = discovered.images[0];
  const origin = new URL(config.site).origin;
  const response = await fetchChecked(url, { headers: { Origin: origin } });
  if (!response.ok) throw new Error(`${url} -> http ${response.status}`);
  const cors = response.headers.get('access-control-allow-origin') || '';
  if (!cors || (cors !== '*' && !cors.includes(origin)))
    throw new Error(`${url} missing/incorrect CORS header (got "${cors}")`);
  return `${url.replace(mediaOrigin, '')} (${cors})`;
}

async function fetchPlaylist(url) {
  const response = await fetchChecked(url);
  if (!response.ok) throw new Error(`${url} -> http ${response.status}`);
  return response.text();
}

async function firstSegment(playlistUrl) {
  let url = playlistUrl;
  let text = await fetchPlaylist(url);
  for (let depth = 0; depth < 3; depth++) {
    if (!text.includes('#EXTM3U')) throw new Error(`not a playlist: ${url}`);
    const next = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))[0];
    if (!next) throw new Error(`no variant/segment in ${url}`);
    const resolved = absolute(next, url);
    if (/\.m3u8(\?|$)/.test(resolved)) {
      url = resolved;
      text = await fetchPlaylist(url);
      continue;
    }
    return { segment: resolved, playlist: url };
  }
  throw new Error(`playlist nesting too deep at ${playlistUrl}`);
}

async function checkHlsRange(discovered) {
  if (!discovered.playlists.length) return 'skipped: no HLS playlist on the live pages';
  const { segment, playlist } = await firstSegment(discovered.playlists[0]);
  const response = await fetchChecked(segment, { headers: { Range: 'bytes=0-1' } });
  if (response.status !== 206)
    throw new Error(`${segment.replace(mediaOrigin, '')} -> http ${response.status} (expected 206)`);
  const range = response.headers.get('content-range') || '';
  if (!range.startsWith('bytes ')) throw new Error(`missing content-range header (got "${range}")`);
  return `${playlist.replace(mediaOrigin, '')} segment ${range}`;
}

// ── Private prefixes and protected routes ──
async function checkPrivatePrefix(path) {
  const url = `${config.media}/${path}`;
  const response = await fetchChecked(url);
  if ([401, 403, 404, 410].includes(response.status)) return `http ${response.status}`;
  if (response.status === 200) {
    if (config.strictPrivate) throw new Error(`${url} is public (http 200) — WAF allowlist missing`);
    return {
      status: 'warn',
      detail: `public (http 200) — ${url} still reachable (PROBE_STRICT_PRIVATE=1 makes this fail)`,
    };
  }
  if (response.status >= 500) throw new Error(`${url} -> http ${response.status} (edge error)`);
  return { status: 'warn', detail: `unexpected http ${response.status} for ${url}` };
}

async function checkProtectedRoute(route) {
  const response = await fetchChecked(`${config.api}${route.path}`, {
    method: route.method,
    headers: route.method === 'POST' ? { 'Content-Type': 'application/json' } : {},
    ...(route.method === 'POST' ? { body: '{}' } : {}),
  });
  if (response.status === 200)
    throw new Error(`${route.name} answered 200 without credentials (privilege escalation?)`);
  if ([401, 403].includes(response.status)) return `http ${response.status}`;
  if (response.status === 503) return `http 503 (PIPELINE_SECRET not configured?)`;
  return `WARN unexpected http ${response.status}`;
}

async function checkAdmin() {
  const response = await fetchChecked(`${config.admin}/`);
  if (!response.ok) throw new Error(`http ${response.status}`);
  const body = await response.text();
  if (!/id="app"|login-screen|mosaic/i.test(body)) throw new Error('admin shell markers missing');
  return `${body.length} bytes`;
}

// ── Alerting ──
async function githubRequest(pathname, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO || process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return null;
  const response = await fetch(`https://api.github.com/repos/${repo}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Mosaic-Probe/1.0',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub ${options.method || 'GET'} ${pathname}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

const ALERT_TITLE = 'ops-alert: production probe failing';

async function reportAlert(failures) {
  const lines = failures.map((check) => `- **${check.name}**: ${check.detail}`).join('\n');
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '';
  const body = [`Probe failures at ${new Date().toISOString()}:`, lines, runUrl ? `Run: ${runUrl}` : ''].join('\n\n');
  try {
    const open = await githubRequest('/issues?state=open&labels=ops-alert&per_page=20');
    if (!open) return;
    const existing = open.find((issue) => issue.title === ALERT_TITLE);
    if (existing) {
      await githubRequest(`/issues/${existing.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
      console.log(`Commented on ops-alert issue #${existing.number}`);
    } else {
      const created = await githubRequest('/issues', {
        method: 'POST',
        body: JSON.stringify({ title: ALERT_TITLE, body, labels: ['ops-alert'] }),
      });
      if (created) console.log(`Opened ops-alert issue #${created.number}`);
    }
  } catch (error) {
    console.error(`warn: could not report the ops alert: ${error.message}`);
  }
}

// ── Run ──
if (!JSON_OUTPUT) console.log(`Probing ${config.site} / ${config.api} / ${config.media}\n`);
await check('Worker health', checkHealth);
await check('GitHub dependency', () => checkDependency('github'));
await check('R2 dependency', () => checkDependency('r2'));
await check('Build snapshot freshness', checkBuildSnapshot);
await check('Homepage', checkHomepage);

const discovered = await discoverMedia();
await check('Processed media CORS', () => checkMediaCors(discovered));
await check('HLS segment Range', () => checkHlsRange(discovered));
for (const path of PRIVATE_PATHS) await check(`Private prefix ${path}`, () => checkPrivatePrefix(path));
for (const route of PROTECTED_ROUTES) await check(`Protected route ${route.name}`, () => checkProtectedRoute(route));
await check('Admin shell', checkAdmin);

const summary = {
  pass: checks.filter((check) => check.status === 'pass').length,
  warn: checks.filter((check) => check.status === 'warn').length,
  fail: checks.filter((check) => check.status === 'fail').length,
};
const failures = checks.filter((check) => check.status === 'fail');

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = checks
    .map((check) => `| ${check.status} | ${check.name} | ${check.detail.replace(/\|/g, '\\|')} |`)
    .join('\n');
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## Production probe\n\n| result | check | detail |\n| --- | --- | --- |\n${rows}\n`,
  );
}

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), config, checks, summary }, null, 2));
} else {
  console.log(`\n${summary.pass} passed, ${summary.warn} warnings, ${summary.fail} failed`);
}

if (failures.length) {
  await reportAlert(failures);
  process.exit(1);
}
