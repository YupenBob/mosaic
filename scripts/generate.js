/**
 * Generate static site: parse posts, build data, render HTML via EJS
 * Replaces generate-data.js + generate-pages.js + plugins
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { marked } from 'marked';
import ejs from 'ejs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content', 'posts');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

// Load config
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'mosaic.config.json'), 'utf-8'));

// R2_PUBLIC priority: pipeline env > config.mediaBase > proxy fallback
const R2_PUBLIC = process.env.R2_PUBLIC_URL || config.mediaBase || '';
const pUrl = (slug, folder, filename) => {
  if (R2_PUBLIC) return `${R2_PUBLIC}/processed/${encodeURIComponent(slug)}/${folder}/${encodeURIComponent(filename)}`;
  return `/api/media/file/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`;
};
const oUrl = (slug, folder, filename) => {
  if (R2_PUBLIC) return `${R2_PUBLIC}/originals/${encodeURIComponent(slug)}/${folder}/${encodeURIComponent(filename)}`;
  return `/api/media/file/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`;
};
const SITE = { ...config, language: config.language || 'zh-CN' };

// Load i18n
const i18n = JSON.parse(fs.readFileSync(path.join(SRC, 'data', 'i18n.json'), 'utf-8'));
const t = (key) => i18n[key]?.[SITE.language] || key;

// ── Parse posts ──
const posts = [];
const postDirs = fs.readdirSync(CONTENT).filter(d => {
  const s = fs.statSync(path.join(CONTENT, d));
  return s.isDirectory() && fs.existsSync(path.join(CONTENT, d, 'index.md'));
});

for (const dir of postDirs) {
  const postPath = path.join(CONTENT, dir);
  const raw = fs.readFileSync(path.join(postPath, 'index.md'), 'utf-8');
  const { data, content } = matter(raw);
  const slug = dir;
  const title = data.title || slug;
  const date = data.date ? new Date(data.date).toISOString() : '';
  const category = data.category || 'uncategorized';
  const tags = data.tags || [];
  const description = data.description || content.slice(0, 200).replace(/[#*`\[\]()\n]/g, '').trim();
  const layout = data.layout || 'default';
  const videoMode = data.video_mode || 'stacked';
  const bodyHTML = marked.parse(content, { breaks: false, gfm: true });

  // ── Photos ──
  const photos = [];
  const photosDir = path.join(postPath, 'photos');
  if (fs.existsSync(photosDir)) {
    for (const f of fs.readdirSync(photosDir).sort()) {
      if (!/\.(jpg|jpeg|png|webp)$/i.test(f)) continue;
      const base = path.parse(f).name;
      photos.push({
        base,
        src10p: pUrl(slug, 'photos', base + '-10p.webp'),
        src480: pUrl(slug, 'photos', base + '-480p.webp'),
        src720: pUrl(slug, 'photos', base + '-720p.webp'),
        src1080: pUrl(slug, 'photos', base + '-1080p.webp'),
        srcOrig: oUrl(slug, 'photos', f),
        thumb: pUrl(slug, 'photos', base + '-480p.webp'),
      });
    }
  }

  // ── Videos ──
  const videos = [];
  const videosDir = path.join(postPath, 'videos');
  if (fs.existsSync(videosDir)) {
    for (const f of fs.readdirSync(videosDir).sort()) {
      if (!/\.(mp4|mov|avi|mkv|webm)$/i.test(f)) continue;
      const rawBase = path.parse(f).name;
      const base = rawBase.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'video';
      const poster = pUrl(slug, 'videos', base + '-poster.jpg');

      // Check for compressed versions in dist/
      const sources = {};
      let hasHLS = false;
      const outDir = path.join(DIST, 'posts', slug, 'media', 'videos');
      if (fs.existsSync(outDir)) {
        const masterM3U8 = path.join(outDir, `${base}-master.m3u8`);
        hasHLS = fs.existsSync(masterM3U8);
        for (const res of ['4K','1080p','720p','480p','360p']) {
          const mp4 = path.join(outDir, `${base}-${res}.mp4`);
          if (fs.existsSync(mp4)) sources[res] = pUrl(slug, 'videos', base + '-' + res + '.mp4');
        }
      }

      if (hasHLS) {
        videos.push({ base, poster, hls: pUrl(slug, 'videos', base + '-master.m3u8'), ...(Object.keys(sources).length ? { sources } : {}) });
      } else if (Object.keys(sources).length) {
        videos.push({ base, poster, sources });
      } else {
        videos.push({ base, src: oUrl(slug, 'videos', f), poster });
      }
    }
  }

  // ── Cover ──
  let cover = data.cover || '';
  let coverSrcset = null;
  let coverAspect = 1.778;

  // Auto-detect cover
  if (!cover) {
    if (videos.length && videos[0].poster) cover = videos[0].poster;
    else if (photos.length) {
      cover = photos[0].src480;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(DIST, 'posts', slug, 'media', 'photos', `${photos[0].base}-meta.json`), 'utf-8'));
        coverAspect = meta.aspect || 1.5;
      } catch {}
    }
  }
  // Check if compressed cover exists (manual cover, not auto-detected from media)
  if (cover && !cover.startsWith('http') && !cover.startsWith('/')) {
    const coverMeta = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIST, 'posts', slug, 'media', 'cover-meta.json'), 'utf-8')); } catch { return null; } })();
    if (coverMeta) {
      coverAspect = coverMeta.aspect || 1.778;
      cover = pUrl(slug, 'covers', 'cover-10p.webp');
      coverSrcset = {
        '480': pUrl(slug, 'covers', 'cover-480p.webp'),
        '720': pUrl(slug, 'covers', 'cover-720p.webp'),
        '1080': pUrl(slug, 'covers', 'cover-1080p.webp'),
      };
    } else {
      cover = ''; // No cover file on disk
    }
  }

  const stats = { views: data.views || 0, likes: data.likes || 0, dwell_time: data.dwell_time || 0 };
  if (coverAspect > 1.5) coverAspect = 1.5;
  posts.push({ slug, title, date, category, tags, description, layout, videoMode, cover, coverAspect, coverSrcset, bodyHTML, photos, videos, stats });
}

// Sort by date desc
posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

// ── Build categories/tags ──
const catTree = {};
const tagMap = {};
for (const p of posts) {
  const parts = (p.category || 'uncategorized').split('/');
  let node = catTree;
  for (const part of parts) {
    const name = part.trim();
    if (!name) continue;
    if (!node[name]) node[name] = { _count: 0, _children: {} };
    node[name]._count++;
    node = node[name]._children;
  }
  for (const t of p.tags) { tagMap[t] = (tagMap[t] || 0) + 1; }
}

function flattenTree(obj, depth = 0) {
  return Object.keys(obj).filter(k => !k.startsWith('_')).map(k => ({
    name: k, slug: k.toLowerCase().replace(/\s+/g, '-'), count: obj[k]._count, depth,
    children: flattenTree(obj[k]._children, depth + 1)
  }));
}
const categories = flattenTree(catTree);
const tags = Object.entries(tagMap).map(([name, count]) => ({ name, slug: name.toLowerCase().replace(/\s+/g, '-'), count }));

// ── Write data files ──
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
fs.writeFileSync(path.join(DIST, 'data', 'posts.json'), JSON.stringify(posts));
fs.writeFileSync(path.join(DIST, 'data', 'categories.json'), JSON.stringify(categories));
fs.writeFileSync(path.join(DIST, 'data', 'tags.json'), JSON.stringify(tags));

// Build search index
const searchIndex = posts.map(p => ({
  slug: p.slug, title: p.title, description: p.description,
  category: p.category, tags: p.tags.join(' '),
}));
fs.writeFileSync(path.join(DIST, 'data', 'search-index.json'), JSON.stringify(searchIndex));

// ── EJS rendering ──
const viewsDir = path.join(SRC, 'layouts');
const relativePath = (from, to) => {
  let rel = path.relative(path.dirname(from), to).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel.endsWith('/') ? rel : rel + '/';
};

function renderFile(template, outPath, data) {
  const rp = relativePath(outPath, path.join(DIST, 'index.html'));
  const html = ejs.render(fs.readFileSync(path.join(viewsDir, template), 'utf-8'), {
    ...data, rp, site: SITE, t, i18n, categories, tags, lang: SITE.language || 'zh-CN',
    activeCategory: data.activeCategory || '',
    activeTag: data.activeTag || '',
    pageTitle: data.titleExtra ? SITE.title + (data.titleExtra || '') : SITE.title,
    pageDescription: SITE.description,
    currentPage: data.page || 1, totalPages: data.totalPages || 1,
    prev: data.page > 1 ? (data.page === 2 ? 'index.html' : `page/${data.page - 1}/index.html`) : '',
    next: data.page < data.totalPages ? `page/${data.page + 1}/index.html` : '',
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
}

// Index page
const pageSize = SITE.pageSize || 50;
const totalPages = Math.ceil(posts.length / pageSize);
for (let page = 1; page <= totalPages; page++) {
  const pagePosts = posts.slice((page - 1) * pageSize, page * pageSize);
  renderFile('index.ejs', path.join(DIST, page === 1 ? 'index.html' : `page/${page}/index.html`), {
    posts: pagePosts, categories, tags, page, totalPages,
  });
}

// Post pages
for (const post of posts) {
  const related = posts.filter(p => p.slug !== post.slug && ((p.category || '') === (post.category || '') || (p.tags || []).some(t => (post.tags || []).includes(t)))).slice(0, 4);
  renderFile('post.ejs', path.join(DIST, 'posts', post.slug, 'index.html'), { post, posts, related });
}

// Category pages
for (const cat of categories) {
  const catPosts = posts.filter(p => (p.category || '').startsWith(cat.name));
  renderFile('index.ejs', path.join(DIST, 'categories', cat.slug, 'index.html'), {
    posts: catPosts, categories, tags, activeCategory: cat.name, titleExtra: ` / ${cat.name}`,
  });
  for (const child of cat.children) {
    const childPosts = catPosts.filter(p => (p.category || '').startsWith(`${cat.name}/${child.name}`));
    renderFile('index.ejs', path.join(DIST, 'categories', cat.slug, child.slug, 'index.html'), {
      posts: childPosts, categories, tags, activeCategory: `${cat.name}/${child.name}`, titleExtra: ` / ${cat.name} / ${child.name}`,
    });
  }
}

// Tag pages
for (const tag of tags) {
  const tagPosts = posts.filter(p => (p.tags || []).includes(tag.name));
  renderFile('index.ejs', path.join(DIST, 'tags', tag.slug, 'index.html'), {
    posts: tagPosts, categories, tags, activeTag: tag.name, titleExtra: ` / #${tag.name}`,
  });
}

// 404
renderFile('404.ejs', path.join(DIST, '404.html'), { posts: [], categories: [], tags: [] });

// Copy assets
const assetsDir = path.join(SRC, 'assets');
if (fs.existsSync(assetsDir)) {
  fs.cpSync(assetsDir, path.join(DIST, 'assets'), { recursive: true });
}

console.log(`Generated: ${posts.length} posts, ${categories.length} categories, ${tags.length} tags`);
