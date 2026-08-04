/**
 * Sync the canonical Pages proxy (shared/pages-proxy.mjs) to the two deployed
 * copies:
 *   - functions/api/[[path]].js             (front site)
 *   - cloud-admin/functions/api/[[path]].js (admin)
 *
 * Usage:
 *   node scripts/sync-proxy.mjs         # overwrite both copies
 *   node scripts/sync-proxy.mjs --check # exit 1 if any copy is stale
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CANONICAL = path.join(ROOT, 'shared', 'pages-proxy.mjs');
const TARGETS = [
  path.join(ROOT, 'functions', 'api', '[[path]].js'),
  path.join(ROOT, 'cloud-admin', 'functions', 'api', '[[path]].js'),
];
const HEADER = `/**
 * AUTO-GENERATED — do not edit directly.
 * Source: shared/pages-proxy.mjs — run \`node scripts/sync-proxy.mjs\`.
 */
`;

const source = fs.readFileSync(CANONICAL, 'utf8');
const generated = HEADER + source;

if (process.argv.includes('--check')) {
  let stale = false;
  for (const target of TARGETS) {
    const ok = fs.existsSync(target) && fs.readFileSync(target, 'utf8') === generated;
    console.log(`${ok ? 'OK  ' : 'STALE'} ${path.relative(ROOT, target)}`);
    if (!ok) stale = true;
  }
  process.exit(stale ? 1 : 0);
}

for (const target of TARGETS) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, generated);
  console.log(`synced ${path.relative(ROOT, target)}`);
}
