/**
 * Build smoke test: verifies the incremental compression cache-hit path and
 * that generate produces the expected static artifacts.
 *
 * Run: node tests/build-smoke.mjs
 *
 * Behavior:
 *   1. Runs `node scripts/compress.js` twice against the same checksum file
 *      (dist/.media-checksums.json, the one used by the CI pipeline). The
 *      second run must be a cache-hit (SKIP) run and must not fail.
 *   2. Runs `node scripts/generate.js` and asserts dist/index.html,
 *      dist/feed.xml and dist/sitemap.xml exist.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHECKSUMS_FILE = path.join(ROOT, 'dist', '.media-checksums.json');

function run(args) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`);
  if (!ok) failures++;
};

console.log('\n== compress: run 1 (cache-warm) ==');
const r1 = run(['scripts/compress.js']);
check('compress run 1 exits 0', r1.status === 0, `status=${r1.status}`);
if (r1.status !== 0) console.error(r1.stderr.slice(0, 2000));

console.log('\n== compress: run 2 (expect cache-hit) ==');
const r2 = run(['scripts/compress.js']);
check('compress run 2 exits 0', r2.status === 0, `status=${r2.status}`);
if (r2.status !== 0) console.error(r2.stderr.slice(0, 2000));

let hasMedia = false;
try {
  const checksums = JSON.parse(fs.readFileSync(CHECKSUMS_FILE, 'utf8'));
  hasMedia = Object.keys(checksums).some((k) => k !== '__version__');
} catch {}
if (hasMedia) {
  check('compress run 2 is cache-hit (SKIP)', /SKIP/.test(r2.stdout), 'expected SKIP lines');
} else {
  console.log('  (no media present — SKIP assertion skipped)');
}

console.log('\n== generate ==');
const g = run(['scripts/generate.js']);
check('generate exits 0', g.status === 0, `status=${g.status}`);
if (g.status !== 0) console.error(g.stderr.slice(0, 2000));
for (const f of ['index.html', 'feed.xml', 'sitemap.xml']) {
  check(`dist/${f} exists`, fs.existsSync(path.join(ROOT, 'dist', f)));
}

console.log(`\nbuild-smoke: ${failures === 0 ? 'OK' : failures + ' failure(s)'}`);
process.exit(failures === 0 ? 0 : 1);
