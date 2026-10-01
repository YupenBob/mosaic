/** Syntax-check every owned JS module, instead of checking only node's first argument. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const roots = [
  'scripts',
  'shared',
  'src/assets/js',
  'cloud-admin/js',
  'cloud-admin/src',
  'worker/src',
  'worker/scripts',
  'tests',
  'functions',
];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(m?js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status) throw new Error(result.stderr);
    }
  }
}
roots.forEach(walk);
const proxy = spawnSync(process.execPath, ['scripts/sync-proxy.mjs', '--check'], { stdio: 'inherit' });
if (proxy.status) process.exitCode = proxy.status;
