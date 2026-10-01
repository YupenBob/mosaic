import fs from 'node:fs';
import path from 'node:path';
import ejs from 'ejs';
export function renderSite(context, posts, indexes) {
  ejs.clearCache();
  const { config: SITE, src: SRC, dist: DIST } = context;
  const { categories, tags, categoryPages } = indexes;
  const i18n = JSON.parse(fs.readFileSync(path.join(SRC, 'data/i18n.json'), 'utf8'));
  const t = (key) => i18n[key]?.[SITE.language] || key;
  // ── RSS / Sitemap ──
  const plugins = SITE.plugins || {};
  const compiled = new Map();
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
      ...categoryPages.map(
        (c) =>
          `${base}/categories/${c.full
            .split('/')
            .map((p) => p.toLowerCase().replace(/\s+/g, '-'))
            .join('/')}/`,
      ),
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
  if (SITE.url) {
    const base = SITE.url.replace(/\/+$/, '');
    const robots = ['User-agent: *', 'Allow: /', '', `Sitemap: ${base}/sitemap.xml`, ''].join('\n');
    fs.writeFileSync(path.join(DIST, 'robots.txt'), robots);
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
    if (!compiled.has(template))
      compiled.set(
        template,
        ejs.compile(fs.readFileSync(path.join(viewsDir, template), 'utf8'), {
          filename: path.join(viewsDir, template),
          cache: true,
        }),
      );
    const html = compiled.get(template)({
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
  const totalPages = Math.max(1, Math.ceil(posts.length / pageSize));
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
  const positions = new Map(posts.map((post, index) => [post.slug, index]));
  const categoryRelated = new Map(),
    tagRelated = new Map();
  for (const post of posts) {
    for (const [map, names] of [
      [categoryRelated, [post.category]],
      [tagRelated, post.tags],
    ])
      for (const name of names) {
        const group = map.get(name) || [];
        if (group.length < 5) group.push(post);
        map.set(name, group);
      }
  }
  for (const post of posts) {
    const related = [
      ...new Set([
        ...(categoryRelated.get(post.category) || []),
        ...post.tags.flatMap((tag) => tagRelated.get(tag) || []),
      ]),
    ]
      .filter((p) => p.slug !== post.slug)
      .sort((a, b) => positions.get(a.slug) - positions.get(b.slug))
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

  // Category pages (all nesting depths, indexed once).
  for (const cat of categoryPages) {
    const route = cat.full
      .split('/')
      .map((part) => part.toLowerCase().replace(/\s+/g, '-'))
      .join('/');
    renderFile('index.ejs', path.join(DIST, 'categories', route, 'index.html'), {
      posts: cat.posts,
      categories,
      tags,
      activeCategory: cat.full,
      titleExtra: ` / ${cat.full}`,
    });
  }

  // Tag pages
  for (const tag of tags) {
    const tagPosts = tag.posts;
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
  ejs.clearCache();
}
