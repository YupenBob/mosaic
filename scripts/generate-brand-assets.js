/**
 * Generate brand assets from the user's own logo + site config.
 *
 * The logo in src/assets/logo.svg is only a demo default — each deployer
 * replaces it with their own SVG. This script rasterizes whatever logo.svg
 * is present into the assets the site links to:
 *
 *   dist/assets/apple-touch-icon.png   180x180  (iOS home-screen icon)
 *   dist/assets/og-card.png            1200x630 (default social share card)
 *
 * Run after scripts/generate.js (see the "build" npm script). If the user
 * swaps src/assets/logo.svg or edits mosaic.config.json, the next build
 * regenerates these files automatically.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_ASSETS = path.join(ROOT, 'src', 'assets');
const DIST_ASSETS = path.join(ROOT, 'dist', 'assets');
const LOGO = path.join(SRC_ASSETS, 'logo.svg');

if (!fs.existsSync(LOGO)) {
  console.warn('[brand-assets] src/assets/logo.svg not found; skipping generated icons.');
  process.exit(0);
}

fs.mkdirSync(DIST_ASSETS, { recursive: true });

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'mosaic.config.json'), 'utf-8'));
const title = config.title || 'Mosaic';
const subtitle = config.subtitle || '';
const host = (() => {
  try {
    return new URL(config.url || '').host;
  } catch {
    return '';
  }
})();

// Inner markup of the user's logo (defs + shapes), reused inside generated SVGs.
const logoInner = fs
  .readFileSync(LOGO, 'utf-8')
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>[\s\S]*$/, '');

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- apple-touch-icon: the logo centered on the site's light surface ---
await sharp(
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">` +
      `<rect width="180" height="180" fill="#f5f5f7"/>` +
      `<g transform="translate(26 26)">${logoInner}</g>` +
      `</svg>`,
  ),
)
  .png()
  .toFile(path.join(DIST_ASSETS, 'apple-touch-icon.png'));

// --- og-card: light social card with logo + title + subtitle + host ---
const ogSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">` +
  `<rect width="1200" height="630" fill="#f5f5f7"/>` +
  `<rect x="90" y="60" width="1020" height="510" rx="32" fill="#ffffff"/>` +
  `<g transform="translate(472 102) scale(2)">${logoInner}</g>` +
  `<text x="600" y="440" text-anchor="middle" font-family="'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif" font-size="84" font-weight="700" fill="#1d1d1f">${escXml(title)}</text>` +
  (subtitle
    ? `<text x="600" y="492" text-anchor="middle" font-family="'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif" font-size="32" fill="#86868b">${escXml(subtitle)}</text>`
    : '') +
  (host
    ? `<text x="600" y="538" text-anchor="middle" font-family="'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif" font-size="20" fill="#aeaeb2">${escXml(host)}</text>`
    : '') +
  `</svg>`;

await sharp(Buffer.from(ogSvg)).png().toFile(path.join(DIST_ASSETS, 'og-card.png'));

console.log('[brand-assets] generated apple-touch-icon.png + og-card.png from', path.relative(ROOT, LOGO));
