/**
 * Generate static site: parse posts, build data, render HTML via EJS
 * Replaces generate-data.js + generate-pages.js + plugins
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import ejs from 'ejs';
import { videoBase } from './media-names.mjs';
import { buildBlocks } from './blocks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content', 'posts');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

// Media manifest written by compress.js (and restored via the CI checksum
// cache): lets cache-hit builds emit HLS/multi-res URLs without local outputs.
const mediaChecksums = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIST, '.media-checksums.json'), 'utf-8'));
  } catch {
    return {};
  }
})();

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
const postDirs = fs.readdirSync(CONTENT).filter((d) => {
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
  const description =
    data.description ||
    content
      .slice(0, 200)
      .replace(/[#*`\[\]()\n]/g, '')
      .trim();
  const layout = data.layout || 'default';
  const videoMode = data.video_mode || 'stacked';
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
    const seenVideos = new Set();
    for (const f of fs.readdirSync(videosDir).sort()) {
      if (!/\.(mp4|mov|avi|mkv|webm)$/i.test(f)) continue;
      const base = videoBase(f, seenVideos);
      const poster = pUrl(slug, 'videos', base + '-poster.jpg');

      // Compressed tier list: prefer the compress manifest (works on cache-hit
      // builds where dist/ has no media outputs), fall back to scanning dist/.
      const sources = {};
      let hasHLS = false;
      const manifestRaw = mediaChecksums[`__video__/${slug}/${base}`];
      let manifest = null;
      try {
        manifest = manifestRaw ? JSON.parse(manifestRaw) : null;
      } catch {}
      if (manifest) {
        hasHLS = (manifest.tiers || []).length > 0;
        for (const res of manifest.tiers || []) {
          sources[res] = pUrl(slug, 'videos', base + '-' + res + '.mp4');
        }
      } else {
        const outDir = path.join(DIST, 'posts', slug, 'media', 'videos');
        if (fs.existsSync(outDir)) {
          const masterM3U8 = path.join(outDir, `${base}-master.m3u8`);
          hasHLS = fs.existsSync(masterM3U8);
          for (const res of ['4K', '1080p', '720p', '480p', '360p', '240p']) {
            const mp4 = path.join(outDir, `${base}-${res}.mp4`);
            if (fs.existsSync(mp4)) sources[res] = pUrl(slug, 'videos', base + '-' + res + '.mp4');
          }
        }
      }

      if (hasHLS) {
        videos.push({
          base,
          poster,
          hls: pUrl(slug, 'videos', base + '-master.m3u8'),
          ...(Object.keys(sources).length ? { sources } : {}),
        });
      } else if (Object.keys(sources).length) {
        videos.push({ base, poster, sources });
      } else {
        videos.push({ base, src: oUrl(slug, 'videos', f), poster });
      }
    }
  }

  // ── Music ──
  const music = [];
  const musicDir = path.join(postPath, 'music');
  if (fs.existsSync(musicDir)) {
    for (const f of fs.readdirSync(musicDir).sort()) {
      if (!/\.(mp3|flac|wav|ogg|m4a|aac)$/i.test(f)) continue;
      const base = path.parse(f).name;
      const artist = (data.author && data.author.name) || (SITE.author && SITE.author.name) || '';
      // Prefer compressed MP3s from the pipeline, fall back to originals
      const sources = {};
      const musicOutDir = path.join(DIST, 'posts', slug, 'media', 'music');
      if (fs.existsSync(musicOutDir)) {
        for (const q of ['320k', '128k']) {
          if (fs.existsSync(path.join(musicOutDir, `${base}-${q}.mp3`))) {
            sources[q] = pUrl(slug, 'music', `${base}-${q}.mp3`);
          }
        }
      }
      if (!Object.keys(sources).length) {
        sources['128k'] = oUrl(slug, 'music', f);
        sources['320k'] = oUrl(slug, 'music', f);
      }
      music.push({
        file: f,
        title: base,
        artist,
        cover: '',
        sources,
        duration: 0,
        waveform: null,
      });
    }
  }

  // ── Cover ──
  let cover = data.cover || '';
  let coverSrcset = null;
  let coverAspect = 1.778;

  // Media-index cover syntax written by the admin editor: video:N / photo:N.
  const photoAspectOf = (base) => {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(DIST, 'posts', slug, 'media', 'photos', `${base}-meta.json`), 'utf-8'),
      ).aspect;
    } catch {
      const a = parseFloat(mediaChecksums[`__photo-meta__/${slug}/${base}`]);
      return Number.isFinite(a) ? a : null;
    }
  };
  const videoIdx = /^video:(\d+)$/.exec(cover);
  const photoIdx = /^photo:(\d+)$/.exec(cover);
  if (videoIdx) {
    cover = videos[Number(videoIdx[1])]?.poster || '';
  } else if (photoIdx) {
    const photo = photos[Number(photoIdx[1])];
    if (photo) {
      cover = photo.src480;
      coverAspect = photoAspectOf(photo.base) || coverAspect;
    } else {
      cover = '';
    }
  }

  // Auto-detect cover
  if (!cover) {
    if (videos.length && videos[0].poster) cover = videos[0].poster;
    else if (photos.length) {
      cover = photos[0].src480;
      coverAspect = photoAspectOf(photos[0].base) || 1.5;
    }
  }
  // Check if compressed cover exists (manual cover, not auto-detected from media)
  if (cover && !cover.startsWith('http') && !cover.startsWith('/')) {
    const coverMeta = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(DIST, 'posts', slug, 'media', 'cover-meta.json'), 'utf-8'));
      } catch {}
      const a = parseFloat(mediaChecksums[`__cover-meta__/${slug}`]);
      return Number.isFinite(a) ? { aspect: a } : null;
    })();
    if (coverMeta) {
      coverAspect = coverMeta.aspect || 1.778;
      cover = pUrl(slug, 'covers', 'cover-10p.webp');
      coverSrcset = {
        480: pUrl(slug, 'covers', 'cover-480p.webp'),
        720: pUrl(slug, 'covers', 'cover-720p.webp'),
        1080: pUrl(slug, 'covers', 'cover-1080p.webp'),
      };
    } else {
      cover = ''; // No cover file on disk
    }
  }

  // Music tracks inherit the post cover when they have none
  for (const t of music) {
    if (!t.cover && cover) t.cover = cover;
  }

  // ── Content blocks ──
  const { blocks, bodyHTML } = buildBlocks({
    body: content,
    photos,
    videos,
    music,
    layout,
    videoMode,
  });

  const stats = { views: data.views || 0, likes: data.likes || 0, dwell_time: data.dwell_time || 0 };
  if (coverAspect > 1.5) coverAspect = 1.5;
  if (coverAspect < (SITE.coverAspectMin || 0.5625)) coverAspect = SITE.coverAspectMin || 0.5625;
  posts.push({
    slug,
    title,
    date,
    category,
    tags,
    description,
    layout,
    videoMode,
    cover,
    coverAspect,
    coverSrcset,
    bodyHTML,
    blocks,
    photos,
    videos,
    music,
    stats,
  });
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
  for (const t of p.tags) {
    tagMap[t] = (tagMap[t] || 0) + 1;
  }
}

function flattenTree(obj, depth = 0) {
  return Object.keys(obj)
    .filter((k) => !k.startsWith('_'))
    .map((k) => ({
      name: k,
      slug: k.toLowerCase().replace(/\s+/g, '-'),
      count: obj[k]._count,
      depth,
      children: flattenTree(obj[k]._children, depth + 1),
    }));
}
const categories = flattenTree(catTree);
const tags = Object.entries(tagMap).map(([name, count]) => ({
  name,
  slug: name.toLowerCase().replace(/\s+/g, '-'),
  count,
}));

// ── Write data files ──
fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
fs.writeFileSync(path.join(DIST, 'data', 'posts.json'), JSON.stringify(posts));
fs.writeFileSync(path.join(DIST, 'data', 'categories.json'), JSON.stringify(categories));
fs.writeFileSync(path.join(DIST, 'data', 'tags.json'), JSON.stringify(tags));

// Build search index
const searchIndex = posts.map((p) => ({
  slug: p.slug,
  title: p.title,
  description: p.description,
  category: p.category,
  tags: p.tags.join(' '),
}));
fs.writeFileSync(path.join(DIST, 'data', 'search-index.json'), JSON.stringify(searchIndex));

// ── RSS / Sitemap ──
const plugins = SITE.plugins || {};
const feedEnabled = plugins['generate-feed']?.enabled !== false;
const sitemapEnabled = plugins['generate-sitemap']?.enabled !== false;

function buildFeed() {
  const base = (SITE.url || '').replace(/\/+$/, '');
  const siteTitle = SITE.title || 'Mosaic';
  const siteDesc = SITE.description || '';
  const authorName = (SITE.author && SITE.author.name) || '';
  const authorEmail = (SITE.author && SITE.author.email) || '';
  const items = posts
    .map((p) => {
      const link = `${base}/posts/${encodeURIComponent(p.slug)}/`;
      const pubDate = p.date ? new Date(p.date).toUTCString() : new Date().toUTCString();
      return [
        '  <item>',
        `    <title><![CDATA[${p.title || p.slug}]]></title>`,
        `    <link>${link}</link>`,
        `    <guid isPermaLink="true">${link}</guid>`,
        `    <description><![CDATA[${p.description || ''}]]></description>`,
        `    <pubDate>${pubDate}</pubDate>`,
        authorName ? `    <dc:creator><![CDATA[${authorName}]]></dc:creator>` : '',
        '  </item>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
  const self = base ? `<atom:link href="${base}/feed.xml" rel="self" type="application/rss+xml"/>` : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `<channel>\n` +
    `  <title><![CDATA[${siteTitle}]]></title>\n` +
    `  <link>${base || '/'}</link>\n` +
    `  <description><![CDATA[${siteDesc}]]></description>\n` +
    (self ? `  ${self}\n` : '') +
    (authorEmail && authorName ? `  <managingEditor>${authorEmail} (${authorName})</managingEditor>\n` : '') +
    `${items}\n` +
    `</channel>\n</rss>\n`
  );
}

function buildSitemap() {
  const base = (SITE.url || '').replace(/\/+$/, '');
  const lastmod =
    posts.length && posts[0].date
      ? new Date(posts[0].date).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
  const locs = [
    `${base}/`,
    `${base}/404.html`,
    ...categories.map((c) => `${base}/categories/${c.slug}/`),
    ...tags.map((t) => `${base}/tags/${t.slug}/`),
    ...posts.map((p) => `${base}/posts/${encodeURIComponent(p.slug)}/`),
  ];
  const urls = locs
    .map((loc) => `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`)
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );
}

if (feedEnabled) {
  fs.writeFileSync(path.join(DIST, 'feed.xml'), buildFeed());
}
if (sitemapEnabled) {
  if (SITE.url) {
    fs.writeFileSync(path.join(DIST, 'sitemap.xml'), buildSitemap());
  } else {
    console.warn('Sitemap skipped: config.url is not set (sitemap requires absolute URLs)');
  }
}

// ── EJS rendering ──
const viewsDir = path.join(SRC, 'layouts');
// Prefix from the output page's directory back to dist/ root ('' | '../' | '../../')
const relativePath = (outPath) => {
  let rel = path.relative(path.dirname(outPath), DIST).replace(/\\/g, '/');
  if (rel === '') return '';
  return rel.endsWith('/') ? rel : rel + '/';
};

function renderFile(template, outPath, data) {
  const rp = relativePath(outPath);
  const html = ejs.render(fs.readFileSync(path.join(viewsDir, template), 'utf-8'), {
    ...data,
    rp,
    site: SITE,
    t,
    i18n,
    categories,
    tags,
    lang: SITE.language || 'zh-CN',
    activeCategory: data.activeCategory || '',
    activeTag: data.activeTag || '',
    pageTitle: data.titleExtra ? SITE.title + (data.titleExtra || '') : SITE.title,
    pageDescription: SITE.description,
    currentPage: data.page || 1,
    totalPages: data.totalPages || 1,
    ...(data.page
      ? {
          prev: data.page > 1 ? (data.page === 2 ? 'index.html' : `page/${data.page - 1}/index.html`) : '',
          next: data.page < data.totalPages ? `page/${data.page + 1}/index.html` : '',
        }
      : {}),
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
    posts: pagePosts,
    categories,
    tags,
    page,
    totalPages,
  });
}

// Post pages
for (const post of posts) {
  const related = posts
    .filter(
      (p) =>
        p.slug !== post.slug &&
        ((p.category || '') === (post.category || '') || (p.tags || []).some((t) => (post.tags || []).includes(t))),
    )
    .slice(0, 4);
  const idx = posts.indexOf(post);
  renderFile('post.ejs', path.join(DIST, 'posts', post.slug, 'index.html'), {
    post,
    posts,
    related,
    prev: posts[idx + 1] || null,
    next: posts[idx - 1] || null,
  });
}

// Category pages
for (const cat of categories) {
  const catPosts = posts.filter((p) => (p.category || '').startsWith(cat.name));
  renderFile('index.ejs', path.join(DIST, 'categories', cat.slug, 'index.html'), {
    posts: catPosts,
    categories,
    tags,
    activeCategory: cat.name,
    titleExtra: ` / ${cat.name}`,
  });
  for (const child of cat.children) {
    const childPosts = catPosts.filter((p) => (p.category || '').startsWith(`${cat.name}/${child.name}`));
    renderFile('index.ejs', path.join(DIST, 'categories', cat.slug, child.slug, 'index.html'), {
      posts: childPosts,
      categories,
      tags,
      activeCategory: `${cat.name}/${child.name}`,
      titleExtra: ` / ${cat.name} / ${child.name}`,
    });
  }
}

// Tag pages
for (const tag of tags) {
  const tagPosts = posts.filter((p) => (p.tags || []).includes(tag.name));
  renderFile('index.ejs', path.join(DIST, 'tags', tag.slug, 'index.html'), {
    posts: tagPosts,
    categories,
    tags,
    activeTag: tag.name,
    titleExtra: ` / #${tag.name}`,
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
