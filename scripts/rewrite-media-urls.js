/**
 * Post-build: rewrite all media paths in dist/ HTML files to Worker proxy or R2 URLs.
 * Run AFTER `npm run build`.
 *
 * Env vars:
 *   WORKER_API_BASE → rewrite to Worker proxy (media stays private in R2)
 *   R2_PUBLIC_URL   → rewrite to direct R2 public URL
 *   neither          → no-op (media served from same origin)
 */
import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import { log, DIST_DIR } from './utils.js';

const MEDIA_BASE = (process.env.R2_PUBLIC_URL || process.env.WORKER_API_BASE || '').replace(/\/+$/, '');
if (!MEDIA_BASE) {
  log('[rewrite-media-urls] No WORKER_API_BASE or R2_PUBLIC_URL set — keeping relative paths');
  process.exit(0);
}

const USE_PROXY = !process.env.R2_PUBLIC_URL && !!process.env.WORKER_API_BASE;
log(`[rewrite-media-urls] Rewriting media paths to ${MEDIA_BASE} (proxy: ${USE_PROXY})`);

// Find all HTML files in dist/
const htmlFiles = glob.sync('**/*.html', { cwd: DIST_DIR, nodir: true });
let totalRewrites = 0;

for (const rel of htmlFiles) {
  const filePath = path.join(DIST_DIR, rel);
  let html = await fs.readFile(filePath, 'utf8');
  let count = 0;

  // Match media/ paths in src, srcset, href, content, data-src*, poster attributes
  // Pattern: any path starting with media/ (photos, videos, cover, music)
  html = html.replace(
    /(src|srcset|href|content|data-src480|data-src720|data-src1080|poster|data-hls)=["'](media\/(photos|videos|music|covers)\/[^"']+)["']/g,
    (match, attr, relPath, folder) => {
      const filename = relPath.split('/').pop();
      let newUrl;
      if (USE_PROXY) {
        // Worker proxy — need to figure out the slug from the file path
        // The HTML is in a post directory like dist/posts/{slug}/index.html
        const postDir = path.dirname(filePath);
        const slug = path.basename(postDir);
        newUrl = `${MEDIA_BASE}/api/media/file/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`;
      } else {
        // R2 direct — same folder structure
        newUrl = `${MEDIA_BASE}/processed/${relPath.replace(/^media\//, '')}`;
        // Fix 'covers' folder for cover images
        if (relPath.includes('cover-')) {
          const slug = path.basename(path.dirname(filePath));
          newUrl = `${MEDIA_BASE}/processed/${slug}/covers/${filename}`;
        }
      }
      count++;
      return `${attr}="${newUrl}"`;
    }
  );

  // Also handle bare media/ paths in srcset that might be comma-separated without quotes
  // (some templates inline srcset without quoting individual URLs)
  if (!USE_PROXY) {
    const postDir = path.dirname(filePath);
    const slug = path.basename(postDir);
    html = html.replace(
      /https?:\/\/[^"'\s]*\/api\/media\/file\/[^"'\s]+/g,
      (match) => match // already rewritten, skip
    );
  }

  if (count > 0) {
    await fs.writeFile(filePath, html, 'utf8');
    totalRewrites += count;
    log(`  ${rel}: ${count} URLs rewritten`);
  }
}

// Also rewrite JSON data files (posts.json, search-index.json)
const jsonFiles = glob.sync('data/*.json', { cwd: DIST_DIR, nodir: true });
for (const rel of jsonFiles) {
  const filePath = path.join(DIST_DIR, rel);
  let json = await fs.readFile(filePath, 'utf8');
  const before = json.length;

  if (USE_PROXY) {
    // For JSON, we need to match the relative paths and replace with proxy URLs
    // But we don't know the slug from the JSON context alone
    // The JSON data has the slug as a key or property
    // Actually, we'll skip JSON for now — the frontend JS can resolve relative URLs
  } else {
    // Direct R2: replace all media/ paths
    json = json.replace(/"media\/(photos|videos|music|covers)\/([^"]+)"/g, (match, folder, filename) => {
      return `"${MEDIA_BASE}/processed/${folder}/${filename}"`;
    });
  }

  if (json.length !== before) {
    await fs.writeFile(filePath, json, 'utf8');
    log(`  ${rel}: JSON media paths rewritten`);
  }
}

log(`[rewrite-media-urls] Done — ${totalRewrites} URLs rewritten across ${htmlFiles.length} files`);
