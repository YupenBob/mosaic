/**
 * Mosaic Build — thin orchestrator, delegates all logic to plugins.
 */
import fs from 'fs-extra';
import path from 'path';
import { DIST_DIR, ROOT, SRC_DIR, CONTENT_DIR, ensureDir, copyDir, readJSON, writeJSON, getMtime, log, warn } from './utils.js';
import { runPlugins } from './plugins/_manager.js';
import imagePlugin from './plugins/compress-images.js';
import videoPlugin from './plugins/compress-videos.js';
import musicPlugin from './plugins/extract-music.js';
import generatePlugin from './plugins/generate.js';

const MANIFEST_PATH = path.join(DIST_DIR, '.build-manifest.json');

async function build() {
  const startTime = Date.now();
  const clean = process.argv.includes('--clean');
  const timings = [];
  const ctx = { site: null, posts: null, categories: null, tags: null, timings };

  log('=== Mosaic Build Started ===' + (clean ? ' [clean]' : ' [incremental]'));

  // 1. Clean or preserve
  if (clean) { await fs.remove(DIST_DIR); await ensureDir(DIST_DIR); }
  else { await ensureDir(DIST_DIR); }

  // 2. Load config
  ctx.site = await readJSON(path.join(ROOT, 'mosaic.config.json'))
    || await readJSON(path.join(SRC_DIR, 'data', 'site.json'))
    || { title: 'Mosaic', pageSize: 50 };

  const assetsPlugin = {
    name: 'assets', enabled: true, priority: 40,
    async run() { await copyDir(path.join(SRC_DIR, 'assets'), path.join(DIST_DIR, 'assets')); return 'copied'; }
  };

  const feedPlugin = {
    name: 'feed', enabled: true, priority: 50,
    async run() {
      const posts = await readJSON(path.join(DIST_DIR, 'data', 'posts.json')) || [];
      const site = ctx.site;
      const entries = posts.slice(0, 20).map(p => {
        const url = (site.url||'') + '/posts/' + p.slug + '/';
        return `  <entry><title>${p.title}</title><link href="${url}"/><id>${url}</id><updated>${p.date||''}</updated><summary>${p.description||''}</summary></entry>`;
      }).join('\n');
      const xml = `<?xml version="1.0"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <title>${site.title}</title>\n  <link href="${site.url||''}/"/>\n  <updated>${new Date().toISOString()}</updated>\n${entries}\n</feed>`;
      await fs.writeFile(path.join(DIST_DIR, 'feed.xml'), xml);
      return 'generated';
    }
  };

  const sitemapPlugin = {
    name: 'sitemap', enabled: true, priority: 60,
    async run() {
      const posts = await readJSON(path.join(DIST_DIR, 'data', 'posts.json')) || [];
      const baseUrl = ctx.site.url || 'https://example.com';
      const today = new Date().toISOString().split('T')[0];
      const url = (loc, prio, date) => `  <url><loc>${loc}</loc><lastmod>${date||today}</lastmod><changefreq>weekly</changefreq><priority>${prio}</priority></url>`;
      const entries = [url(baseUrl+'/', '1.0'), url(baseUrl+'/404.html', '0.1')];
      for (const p of posts) entries.push(url(baseUrl+'/posts/'+p.slug+'/', '0.8', p.date?.split('T')[0]));
      const cats = await readJSON(path.join(DIST_DIR, 'data', 'categories.json')) || [];
      const tags = await readJSON(path.join(DIST_DIR, 'data', 'tags.json')) || [];
      for (const c of cats) entries.push(url(baseUrl+'/categories/'+c.slug+'/', '0.5'));
      for (const t of tags) entries.push(url(baseUrl+'/tags/'+t.slug+'/', '0.5'));
      const xml = `<?xml version="1.0"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>`;
      await fs.writeFile(path.join(DIST_DIR, 'sitemap.xml'), xml);
      return 'generated';
    }
  };

  // 3. Run all plugins
  await runPlugins([imagePlugin, videoPlugin, musicPlugin, generatePlugin, assetsPlugin, feedPlugin, sitemapPlugin], ctx);

  // Save manifest
  await saveManifest(ctx);

  // Summary
  const total = ((Date.now() - startTime) / 1000).toFixed(1);
  log('──────────────────────────────');
  timings.forEach(t => log(`  ${t.name.padEnd(12)} ${(t.ms/1000).toFixed(1).padStart(5)}s  ${t.detail||''}`));
  log('  ────────────────────────────');
  log(`  Total       ${total.padStart(5)}s  Output: ${DIST_DIR}`);
}

async function saveManifest(ctx) {
  const simple = { posts: {}, assets: {} };
  const postDirs = fs.readdirSync(CONTENT_DIR).filter(d => { try { return fs.statSync(path.join(CONTENT_DIR, d)).isDirectory(); } catch { return false; } });
  for (const dir of postDirs) {
    const md = path.join(CONTENT_DIR, dir, 'index.md');
    simple.posts[dir] = getMtime(md);
  }
  // Asset mtimes
  const assets = path.join(SRC_DIR, 'assets');
  if (fs.existsSync(assets)) {
    const walk = (d, list=[]) => {
      fs.readdirSync(d, {withFileTypes:true}).forEach(e => {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp, list); else list.push(fp);
      }); return list;
    };
    for (const f of walk(assets)) simple.assets[path.relative(assets, f).replace(/\\/g,'/')] = getMtime(f);
  }
  await writeJSON(MANIFEST_PATH, simple);
}

// Watch mode
if (process.argv.includes('--watch')) {
  log('Watching for changes (Ctrl+C to stop)...');
  const watched = [CONTENT_DIR, path.join(SRC_DIR, 'assets'), path.join(SRC_DIR, 'layouts'), path.join(SRC_DIR, 'data')];
  let timer;
  watched.forEach(dir => {
    if (!fs.existsSync(dir)) return;
    fs.watch(dir, { recursive: true }, (event, name) => {
      if (!name) return;
      clearTimeout(timer);
      log(`Change: ${name}`);
      timer = setTimeout(() => build().catch(console.error), 500);
    });
  });
  build().catch(console.error);
} else {
  build().catch(err => { console.error(err); process.exit(1); });
}
