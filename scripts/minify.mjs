/**
 * Minify the generated frontend assets (dist/assets) with esbuild.
 * Source modules stay separate; the published application has one dependency graph.
 *
 * Run: node scripts/minify.mjs   (called at the end of `npm run build`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadContext } from './lib/context.mjs';
import { transform, build } from 'esbuild';
import { stampApp } from './lib/published-assets.mjs';

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
await build({
  entryPoints: [path.join(ROOT, 'src/assets/js/app.js')],
  outfile: path.join(ASSETS, 'js/app.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
});
console.log('Minify complete');
console.log('Published app:', stampApp(dist));
