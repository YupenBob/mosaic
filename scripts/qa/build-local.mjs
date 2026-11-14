/**
 * Build a full local copy of the production site for QA journeys.
 *
 * The published media manifest is fetched once and cached under `.mosaic/qa/`
 * (gitignored). The site itself is generated into `.mosaic/qa/site/` so QA
 * never touches `dist/`. Media URLs still point at the production CDN (read
 * only) which keeps playback/zoom journeys realistic.
 *
 * Usage:
 *   node scripts/qa/build-local.mjs             # reuse cache if fresh
 *   node scripts/qa/build-local.mjs --refresh   # re-fetch manifest + rebuild
 *   node scripts/qa/build-local.mjs --print-base
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QA_DIR = path.join(ROOT, '.mosaic/qa');
const MANIFEST = path.join(QA_DIR, 'media-manifest.json');
const SITE_DIR = path.join(QA_DIR, 'site');
const MEDIA_BASE = process.env.MOSAIC_QA_MEDIA_BASE || 'https://mosaic-media.xsanye.cn';
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const baseUrl = (port) => `http://127.0.0.1:${port}`;
export const siteDirectory = SITE_DIR;

function log(message) {
  console.log(`[qa-build] ${message}`);
}

async function ensureManifest({ refresh }) {
  fs.mkdirSync(QA_DIR, { recursive: true });
  const fresh =
    fs.existsSync(MANIFEST) && Date.now() - fs.statSync(MANIFEST).mtimeMs < MAX_AGE_MS;
  if (fresh && !refresh) {
    log(`reusing manifest (${(fs.statSync(MANIFEST).size / 1024).toFixed(0)} KiB)`);
    return;
  }
  log('fetching published media manifest');
  const response = await fetch(`${MEDIA_BASE.replace(/\/+$/, '')}/site-data/media-manifest.json`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`manifest fetch failed: HTTP ${response.status}`);
  const body = await response.text();
  const manifest = JSON.parse(body);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest));
  log(`manifest schema v${manifest.schemaVersion ?? '?'} revision ${manifest.revision}`);
}

function run(script, extraEnv = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      MOSAIC_DIST: SITE_DIR,
      MEDIA_MANIFEST_FILE: MANIFEST,
      ...extraEnv,
    },
  });
  if (result.status !== 0) throw new Error(`${script} exited with ${result.status}`);
}

export async function buildLocalSite({ refresh = false } = {}) {
  await ensureManifest({ refresh });
  fs.rmSync(SITE_DIR, { recursive: true, force: true });
  run('scripts/generate.js');
  run('scripts/generate-brand-assets.js');
  run('scripts/minify.mjs');
  const snapshot = path.join(SITE_DIR, 'build-snapshot.json');
  const built = fs.existsSync(snapshot) ? JSON.parse(fs.readFileSync(snapshot, 'utf8')) : {};
  const posts = fs
    .readdirSync(path.join(SITE_DIR, 'posts'))
    .filter((entry) => fs.statSync(path.join(SITE_DIR, 'posts', entry)).isDirectory()).length;
  log(`built ${posts} posts into ${path.relative(ROOT, SITE_DIR)} (media revision ${built.mediaRevision ?? '?'})`);
  return { siteDirectory: SITE_DIR, posts, snapshot: built };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const refresh = process.argv.includes('--refresh');
  if (process.argv.includes('--print-base')) console.log(SITE_DIR);
  else await buildLocalSite({ refresh });
}
