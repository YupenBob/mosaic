/**
 * Post-build: rewrite all media/ paths in dist/ HTML files to Worker proxy or R2 URLs.
 * Run AFTER `npm run build`.
 */
import fs from 'fs';
import path from 'path';

const MEDIA_BASE = (process.env.R2_PUBLIC_URL || process.env.WORKER_API_BASE || '').replace(/\/+$/, '');
if (!MEDIA_BASE) {
  console.log('[rewrite] No WORKER_API_BASE or R2_PUBLIC_URL set — skipping');
  process.exit(0);
}

const USE_PROXY = !process.env.R2_PUBLIC_URL && !!process.env.WORKER_API_BASE;
console.log(`[rewrite] Rewriting media paths to ${MEDIA_BASE} (proxy=${USE_PROXY})`);

const DIST_DIR = path.resolve('dist');
let totalRewrites = 0;
let filesProcessed = 0;

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!e.name.endsWith('.html')) continue;

    const slug = path.basename(path.dirname(full));
    let html = fs.readFileSync(full, 'utf8');
    const original = html;

    // Pattern: any HTML attribute with a media/ path
    html = html.replace(
      /(\s(?:src|srcset|href|content|data-src480|data-src720|data-src1080|poster|data-hls)=)["'](media\/(?:photos|videos|music|covers)\/[^"'\s]+)["']/g,
      (m, attr, relPath) => {
        const filename = relPath.split('/').pop();
        let url;
        if (USE_PROXY) {
          url = `${MEDIA_BASE}/api/media/file/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`;
        } else {
          url = `${MEDIA_BASE}/processed/${relPath.replace(/^media\//, '')}`;
        }
        return `${attr}"${url}"`;
      }
    );

    if (html !== original) {
      fs.writeFileSync(full, html, 'utf8');
      const rewrites = (original.match(/media\/(?:photos|videos|music|covers)\//g) || []).length;
      totalRewrites += rewrites;
      filesProcessed++;
      const rel = path.relative(DIST_DIR, full);
      console.log(`  ${rel}: ~${rewrites} URLs → Worker proxy`);
    }
  }
}

walk(DIST_DIR);
console.log(`[rewrite] Done — ${totalRewrites} URLs in ${filesProcessed} files`);
