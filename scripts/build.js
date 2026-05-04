import fs from 'fs-extra';
import path from 'path';
import { DIST_DIR, ROOT, SRC_DIR, CONTENT_DIR, ensureDir, copyDir, readJSON, writeJSON, getMtime, log, warn } from './utils.js';
import { compressImages } from './compress-images.js';
import { compressVideos } from './compress-videos.js';
import { generateData } from './generate-data.js';
import { generatePages } from './generate-pages.js';

const MANIFEST_PATH = path.join(DIST_DIR, '.build-manifest.json');

async function build() {
  const startTime = Date.now();
  const clean = process.argv.includes('--clean');
  const steps = [];
  function track(name, fn) { return async (...args) => { const t=Date.now(); const r=await fn(...args); steps.push({name,ms:Date.now()-t,detail:r||''}); return r; }; }
  log('=== Mosaic Build Started ===' + (clean ? ' [clean]' : ' [incremental]'));

  // Load previous build manifest for !clean builds
  const prevManifest = clean ? null : await readJSON(MANIFEST_PATH);
  const newManifest = { images: {}, videos: {}, posts: {}, assets: {}, site: {} };

  // 1. Clean or preserve dist
  if (clean) {
    log('1/6 Cleaning dist/...');
    await fs.remove(DIST_DIR);
    await ensureDir(DIST_DIR);
  } else {
    log('1/6 Incremental mode — preserving dist/...');
    await ensureDir(DIST_DIR);
  }

  // 2. Load site config
  log('2/6 Loading site config...');
  const site = await readJSON(path.join(ROOT, 'mosaic.config.json'))
    || await readJSON(path.join(SRC_DIR, 'data', 'site.json'))
    || { title: 'Mosaic', pageSize: 50, gallerySingleThreshold: 5 };
  newManifest.site = getMtime(path.join(SRC_DIR, 'data', 'site.json'));

  // 3. Compress images
  await track('Images', async () => { await compressImages(site.imageQuality); return ''; })();

  // 4. Compress/copy videos
  await track('Videos', async () => {
    if (site.enableVideoCompression) { await compressVideos(site.videoQuality); return 'compressed'; }
    await copySourceVideos(); return 'copied';
  })();

  // 5. Generate data & pages
  const dataChanged = !clean ? contentChanged(prevManifest) : true;
  let postsCount = 0, catCount = 0, tagCount = 0;
  await track('Pages', async () => {
    if (dataChanged || clean) {
      const { posts, categories, tags } = await generateData(site);
      await generatePages(posts, site);
      postsCount = posts.length; catCount = categories?.length||0; tagCount = tags?.length||0;
      return `${postsCount}p ${catCount}c ${tagCount}t`;
    }
    return 'unchanged';
  })();

  // 6. Copy assets
  const srcAssets = path.join(SRC_DIR, 'assets'), dstAssets = path.join(DIST_DIR, 'assets');
  const assetsChanged = !clean ? dirChanged(srcAssets, prevManifest?.assets) : true;
  await track('Assets', async () => {
    if (assetsChanged || clean) { await copyDir(srcAssets, dstAssets); return 'copied'; }
    return 'unchanged';
  })();

  // Sitemap + Feed
  if (dataChanged || clean) {
    const posts = await readJSON(path.join(DIST_DIR, 'data', 'posts.json')) || [];
    await track('Sitemap', generateSitemap)(posts, site);
    await track('RSS', generateFeed)(posts, site);
  }

  // Save manifest
  await saveManifest(newManifest);

  // Summary
  const total = ((Date.now() - startTime) / 1000).toFixed(1);
  log('──────────────────────────────');
  steps.forEach(s => log(`  ${s.name.padEnd(8)} ${(s.ms/1000).toFixed(1).padStart(5)}s  ${s.detail}`));
  log('  ────────────────────────────');
  log(`  Total     ${total.padStart(5)}s  Output: ${DIST_DIR}`);
}

function contentChanged(prev) {
  if (!prev) return true;
  const postDirs = fs.readdirSync(CONTENT_DIR).filter((d) => {
    try { return fs.statSync(path.join(CONTENT_DIR, d)).isDirectory(); } catch { return false; }
  }).sort();
  const prevDirs = Object.keys(prev?.posts || {}).sort();
  if (JSON.stringify(postDirs) !== JSON.stringify(prevDirs)) return true;
  for (const dir of postDirs) {
    const mdPath = path.join(CONTENT_DIR, dir, 'index.md');
    const mtime = getMtime(mdPath);
    if (mtime !== (prev.posts[dir] || 0)) return true;
    // Check photos
    const photosDir = path.join(CONTENT_DIR, dir, 'photos');
    if (fs.existsSync(photosDir)) {
      const files = fs.readdirSync(photosDir);
      for (const f of files) {
        if (getMtime(path.join(photosDir, f)) !== (prev.images[f] || 0)) return true;
      }
    }
    // Check videos
    const videosDir = path.join(CONTENT_DIR, dir, 'videos');
    if (fs.existsSync(videosDir)) {
      const files = fs.readdirSync(videosDir);
      for (const f of files) {
        if (getMtime(path.join(videosDir, f)) !== (prev.videos[f] || 0)) return true;
      }
    }
  }
  return false;
}

function dirChanged(dir, prevMtimes) {
  if (!prevMtimes) return true;
  if (!fs.existsSync(dir)) return false;
  const files = walkDir(dir);
  if (files.length !== Object.keys(prevMtimes).length) return true;
  for (const f of files) {
    const mtime = getMtime(f);
    const rel = path.relative(dir, f).replace(/\\/g, '/');
    if (mtime !== (prevMtimes[rel] || 0)) return true;
  }
  return false;
}

function walkDir(dir, list = []) {
  if (!fs.existsSync(dir)) return list;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(full, list);
    else list.push(full);
  }
  return list;
}

async function saveManifest(manifest) {
  // Simplify: just store mtimes of key source dirs
  const simple = { posts: {}, images: {}, videos: {}, assets: {}, site: manifest.site };
  // Store post mtimes
  const postDirs = fs.readdirSync(CONTENT_DIR).filter((d) => {
    try { return fs.statSync(path.join(CONTENT_DIR, d)).isDirectory(); } catch { return false; }
  });
  for (const dir of postDirs) {
    const md = path.join(CONTENT_DIR, dir, 'index.md');
    simple.posts[dir] = getMtime(md);
  }
  // Store asset mtimes
  const srcAssets = path.join(SRC_DIR, 'assets');
  const assetFiles = walkDir(srcAssets);
  for (const f of assetFiles) {
    simple.assets[path.relative(srcAssets, f).replace(/\\/g, '/')] = getMtime(f);
  }
  await writeJSON(MANIFEST_PATH, simple);
}

async function copySourceVideos() {
  const postDirs = await fs.readdir(CONTENT_DIR).catch(() => []);
  for (const dir of postDirs) {
    const videosDir = path.join(CONTENT_DIR, dir, 'videos');
    if (!(await fs.pathExists(videosDir))) continue;
    const destDir = path.join(DIST_DIR, 'posts', dir, 'media', 'videos');
    await copyDir(videosDir, destDir);
  }
}

async function generateFeed(posts, site) {
  const baseUrl = site?.url || 'https://example.com';
  const updated = new Date().toISOString();
  const entries = posts.slice(0, 20).map((p) => {
    const url = `${baseUrl}/posts/${p.slug}/`;
    const date = p.date || updated;
    return `  <entry>
    <title>${p.title}</title>
    <link href="${url}" />
    <id>${url}</id>
    <updated>${date}</updated>
    <summary>${p.description || ''}</summary>
    <category term="${p.category || 'uncategorized'}" />
  </entry>`;
  }).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${site.title}</title>
  <subtitle>${site.description || ''}</subtitle>
  <link href="${baseUrl}/" />
  <link href="${baseUrl}/feed.xml" rel="self" />
  <updated>${updated}</updated>
  <id>${baseUrl}/</id>
${entries}
</feed>`;
  await fs.writeFile(path.join(DIST_DIR, 'feed.xml'), xml);
  log('  feed.xml generated');
}

async function generateSitemap(posts, site) {
  const baseUrl = site?.url || 'https://example.com';
  const today = new Date().toISOString().split('T')[0];
  const url = (loc, prio, date) =>
    `  <url><loc>${loc}</loc><lastmod>${date || today}</lastmod><changefreq>weekly</changefreq><priority>${prio}</priority></url>`;
  const entries = [
    url(`${baseUrl}/`, '1.0', today),
    url(`${baseUrl}/404.html`, '0.1', today),
  ];
  for (const post of posts) {
    const d = post.date ? post.date.split('T')[0] : today;
    entries.push(url(`${baseUrl}/posts/${post.slug}/`, '0.8', d));
  }
  const categories = await readJSON(path.join(DIST_DIR, 'data', 'categories.json'));
  const tags = await readJSON(path.join(DIST_DIR, 'data', 'tags.json'));
  if (categories) for (const cat of categories) entries.push(url(`${baseUrl}/categories/${cat.slug}/`, '0.5', today));
  if (tags) for (const t of tags) entries.push(url(`${baseUrl}/tags/${t.slug}/`, '0.5', today));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>`;
  await fs.writeFile(path.join(DIST_DIR, 'sitemap.xml'), xml);
}

const doWatch = process.argv.includes('--watch');

if (doWatch) {
  log('Watching for changes (Ctrl+C to stop)...');
  const watched = [CONTENT_DIR, path.join(SRC_DIR, 'assets'), path.join(SRC_DIR, 'data'), path.join(SRC_DIR, 'layouts')];
  let timer;
  watched.forEach((dir) => {
    if (!fs.existsSync(dir)) return;
    fs.watch(dir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      // Debounce: wait 500ms after last change
      clearTimeout(timer);
      log(`Change detected: ${filename}`);
      timer = setTimeout(() => {
        build().catch((err) => console.error(err));
      }, 500);
    });
  });
  // Also run initial build immediately
  build().catch(console.error);
} else {
  build().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
