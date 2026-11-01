/**
 * Bundle + minify the generated frontend assets (dist/assets) with esbuild.
 *
 * - The 14 site stylesheets are concatenated (in cascade order) into a single
 *   `assets/css/bundle.css`, so first paint needs one CSS request instead of
 *   14 sequential ones. The source order is the historical layout order plus
 *   `music.css`, which the layouts never linked before.
 * - The application entry (`src/assets/js/app.js`) is bundled into one ESM
 *   graph; every copied source module that the bundle absorbed is removed from
 *   dist so the published tree contains no unreferenced modules.
 *
 * Run: node scripts/minify.mjs   (called at the end of `npm run build`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadContext } from './lib/context.mjs';
import { transform, build } from 'esbuild';
import { stampApp } from './lib/published-assets.mjs';
import { bundleSiteCss } from './lib/site-css.mjs';

const { root: ROOT, dist } = loadContext();
const ASSETS = path.join(dist, 'assets');
const JS_DIR = path.join(ASSETS, 'js');

async function minifyFile(file) {
  const loader = path.extname(file) === '.css' ? 'css' : 'js';
  const source = fs.readFileSync(file, 'utf8');
  const { code } = await transform(source, { loader, minify: true, target: 'es2020' });
  fs.writeFileSync(file, code);
}

/** Bundle the application entry into one minified ESM file. */
async function bundleApp() {
  if (!fs.existsSync(path.join(ROOT, 'src/assets/js/app.js')) || !fs.existsSync(JS_DIR)) return null;
  const outfile = path.join(JS_DIR, 'app.js');
  await build({
    entryPoints: [path.join(ROOT, 'src/assets/js/app.js')],
    outfile,
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2020',
  });
  // Esbuild inlines dynamic imports without `splitting`, so every source
  // module under assets/js is now dead weight in dist.
  for (const entry of fs.readdirSync(JS_DIR)) {
    if (entry === 'app.js' || /^app\.[0-9a-f]+\.js$/.test(entry)) continue;
    fs.rmSync(path.join(JS_DIR, entry), { recursive: true, force: true });
  }
  return { bytes: fs.statSync(outfile).size };
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

const css = bundleSiteCss(ASSETS);
if (css) console.log(`CSS bundle: ${css.files} files -> assets/css/bundle.css (${css.bytes} B)`);
const app = await bundleApp();
if (app) console.log(`App bundle: ${app.bytes} B`);
await walk(ASSETS);
console.log('Minify complete');
console.log('Published app:', stampApp(dist));
