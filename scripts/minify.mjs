/**
 * Minify the generated frontend assets (dist/assets) with esbuild.
 * Files keep their names and ESM imports (no bundling).
 *
 * Run: node scripts/minify.mjs   (called at the end of `npm run build`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadContext } from './lib/context.mjs';
import { transform } from 'esbuild';

const { root: ROOT, dist } = loadContext();
const ASSETS = path.join(dist, 'assets');

async function minifyFile(file) {
  const loader = path.extname(file) === '.css' ? 'css' : 'js';
  const source = fs.readFileSync(file, 'utf8');
  const { code } = await transform(source, { loader, minify: true, target: 'es2020' });
  fs.writeFileSync(file, code);
}

async function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(p);
    } else if (/\.(js|mjs|css)$/.test(entry.name) && !/\.min\.(js|css)$/.test(entry.name)) {
      await minifyFile(p);
      console.log(`minified ${path.relative(ROOT, p)}`);
    }
  }
}

await walk(ASSETS);
console.log('Minify complete');
