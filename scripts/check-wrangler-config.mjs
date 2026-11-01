/**
 * Verify that every duplication of a deployment constant still matches
 * `shared/deployment.mjs` (compatibility dates, wrangler version).
 *
 * Wrangler TOML manifests cannot import JavaScript and the generated
 * `.mosaic/worker.json` is not checked in, so the only way to keep the runtime
 * surface honest is to assert the literals here. Run by `npm run check` (CI) and
 * locally after bumping wrangler or the compatibility date.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_COMPATIBILITY_DATE, COMPATIBILITY_DATE, WRANGLER_VERSION } from '../shared/deployment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function tomlValue(relative, key) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(read(relative));
  return match ? match[1] : null;
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) errors.push(`${label}: expected ${expected}, found ${actual ?? 'nothing'}`);
  else console.log(`  PASS ${label}: ${actual}`);
}

// ── Wrangler manifests mirror the shared constants ──
console.log('Wrangler manifests');
expectEqual(
  'worker/wrangler.toml compatibility_date',
  tomlValue('worker/wrangler.toml', 'compatibility_date'),
  COMPATIBILITY_DATE,
);
expectEqual(
  'cloud-admin/wrangler.toml compatibility_date',
  tomlValue('cloud-admin/wrangler.toml', 'compatibility_date'),
  ADMIN_COMPATIBILITY_DATE,
);

const workerPackage = JSON.parse(read('worker/package.json'));
expectEqual('worker/package.json wrangler', workerPackage.devDependencies?.wrangler, WRANGLER_VERSION);

// ── Generated Worker config imports the constant instead of a literal ──
console.log('\nGenerated configuration');
const generator = read('scripts/deployment-env.mjs');
if (!/import\s*{[^}]*COMPATIBILITY_DATE[^}]*}\s*from\s*'\.\.\/shared\/deployment\.mjs'/.test(generator))
  errors.push('scripts/deployment-env.mjs must import COMPATIBILITY_DATE from shared/deployment.mjs');
else console.log('  PASS scripts/deployment-env.mjs imports COMPATIBILITY_DATE');
if (/compatibility_date\s*:\s*['"]\d{4}-\d{2}-\d{2}['"]/.test(generator))
  errors.push('scripts/deployment-env.mjs hardcodes a compatibility date literal');
else console.log('  PASS scripts/deployment-env.mjs has no date literal');

// ── No stray compatibility dates outside the single source and the TOMLs ──
const allowed = new Set(['shared/deployment.mjs', 'worker/wrangler.toml', 'cloud-admin/wrangler.toml']);
const ignored = new Set(['node_modules', '.git', 'dist', '.mosaic', 'test-results', 'docs']);
const dateLiteral = /\b(?:compatibility[_-]?date|compatibilityDate)["']?\s*[:=]\s*["']\d{4}-\d{2}-\d{2}/;
const offenders = [];
function walk(relative) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (ignored.has(entry.name)) continue;
    if (entry.isDirectory()) walk(child);
    else if (/\.(?:m?js|json|toml|yml|yaml)$/.test(entry.name) && !allowed.has(child)) {
      if (dateLiteral.test(fs.readFileSync(path.join(root, child), 'utf8'))) offenders.push(child);
    }
  }
}
walk('');
if (offenders.length)
  errors.push(`compatibility date literals found outside shared/deployment.mjs: ${offenders.join(', ')}`);
else console.log('  PASS no compatibility date literals outside shared/deployment.mjs');

if (errors.length) {
  console.error(`\n${errors.length} wrangler configuration problem(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log('\nWrangler configuration matches shared/deployment.mjs');
