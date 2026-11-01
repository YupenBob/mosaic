/**
 * Site stylesheet bundling, shared by the generator and the minify step.
 *
 * The layouts reference a single `assets/css/bundle.css`, so the bundle has to
 * exist for *any* generation path — including tests and previews that call
 * `generateSite()` directly without running `npm run build`. Keeping the logic
 * in one synchronous module (esbuild `buildSync`) means the generator can emit
 * it right after copying `src/assets`, and `scripts/minify.mjs` simply reuses
 * the same cascade order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

/**
 * Cascade order for the site stylesheets. This mirrors the historical
 * `<link>` order used by src/layouts/*.ejs (`music.css` is inserted after
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

export const CSS_BUNDLE = 'bundle.css';

/**
 * Concatenate the site stylesheets into `assets/css/bundle.css` and drop the
 * per-file copies that were folded into it. Idempotent: a dist that only has
 * the bundle left is a no-op.
 * @param {string} assetsDir - `dist/assets`
 * @returns {{files: number, bytes: number}|null}
 */
export function bundleSiteCss(assetsDir) {
  const cssDir = path.join(assetsDir, 'css');
  if (!fs.existsSync(cssDir)) return null;
  const present = CSS_ORDER.filter((name) => fs.existsSync(path.join(cssDir, `${name}.css`)));
  if (!present.length) return null;
  const missing = CSS_ORDER.filter((name) => !present.includes(name));
  if (missing.length) console.warn(`CSS bundle: missing ${missing.join(', ')}`);
  const output = path.join(cssDir, CSS_BUNDLE);
  buildSync({
    stdin: {
      contents: present.map((name) => `@import "./${name}.css";`).join('\n'),
      resolveDir: cssDir,
      loader: 'css',
    },
    bundle: true,
    minify: true,
    target: 'es2020',
    outfile: output,
    logLevel: 'silent',
  });
  for (const name of present) fs.rmSync(path.join(cssDir, `${name}.css`), { force: true });
  return { files: present.length, bytes: fs.statSync(output).size };
}
