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

const { root: ROOT, dist } = loadContext();
const ASSETS = path.join(dist, 'assets');
const CSS_DIR = path.join(ASSETS, 'css');
const JS_DIR = path.join(ASSETS, 'js');
const CSS_BUNDLE = 'bundle.css';

/**
 * Cascade order for the site stylesheets. This mirrors the historical
 * `<link>` order used by src/layouts/index.ejs (`music.css` is inserted after
 * `post.css`; the layouts previously forgot to link it at all).
 */
export const CSS_ORDER = [
  'tokens',
  'reset',
  'layout',
  'card',
  'post',
  'music',
  'gallery',
  'video',
  'filter',
  'motion',
  'icons',
  'note',
  'feed',
  'responsive',
];

async function minifyFile(file) {
  const loader = path.extname(file) === '.css' ? 'css' : 'js';
  const source = fs.readFileSync(file, 'utf8');
  const { code } = await transform(source, { loader, minify: true, target: 'es2020' });
  fs.writeFileSync(file, code);
}

/**
 * Concatenate the site stylesheets into one minified bundle and drop the
 * per-file copies. Failure to find any stylesheet is tolerated so the script
 * also works against a reduced fixture dist.
 */
async function bundleCss() {
  if (!fs.existsSync(CSS_DIR)) return null;
  const present = CSS_ORDER.filter((name) => fs.existsSync(path.join(CSS_DIR, `${name}.css`)));
  const missing = CSS_ORDER.filter((name) => !present.includes(name));
  if (!present.length) return null;
  if (missing.length) console.warn(`CSS bundle: missing ${missing.join(', ')}`);
  const contents = present.map((name) => `@import "./${name}.css";`).join('\n');
  const output = path.join(CSS_DIR, CSS_BUNDLE);
  await build({
    stdin: { contents, resolveDir: CSS_DIR, loader: 'css' },
    bundle: true,
    minify: true,
    target: 'es2020',
    outfile: output,
    logLevel: 'silent',
  });
  // The published page links the bundle only; drop exactly the files that were
  // folded into it (unrelated/custom stylesheets stay available).
  for (const name of present) fs.rmSync(path.join(CSS_DIR, `${name}.css`), { force: true });
  return { files: present.length, bytes: fs.statSync(output).size };
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

const css = await bundleCss();
if (css) console.log(`CSS bundle: ${css.files} files -> assets/css/${CSS_BUNDLE} (${css.bytes} B)`);
const app = await bundleApp();
if (app) console.log(`App bundle: ${app.bytes} B`);
await walk(ASSETS);
console.log('Minify complete');
console.log('Published app:', stampApp(dist));
