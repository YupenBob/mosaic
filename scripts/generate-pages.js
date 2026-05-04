import fs from 'fs-extra';
import path from 'path';
import ejs from 'ejs';
import { DIST_DIR, SRC_DIR, ROOT, ensureDir, writeFile, copyDir, readJSON, log } from './utils.js';

const LAYOUTS_DIR = path.join(SRC_DIR, 'layouts');
const PARTIALS_DIR = path.join(SRC_DIR, 'partials');
const ASSETS_DIR = path.join(SRC_DIR, 'assets');

let _t = (k) => k;
let _i18n = {};
let _lang = 'zh-CN';

async function renderTemplate(templateName, data) {
  const templatePath = path.join(LAYOUTS_DIR, templateName);
  const partialPath = path.join(PARTIALS_DIR, `${templateName}`);
  const partial = await fs.pathExists(partialPath) ? await fs.readFile(partialPath, 'utf-8') : '';
  const tpl = await fs.readFile(templatePath, 'utf-8');
  return ejs.render(tpl, {
    ...data,
    partials: data.partials || {},
    filename: templatePath,
  });
}

/**
 * Render a list page (index or category or tag filtered)
 */
async function renderListPage(posts, site, opts = {}) {
  const { category, tag } = opts;
  const pageSize = site.pageSize || 12;

  let filtered = [...posts];
  let titleExtra = '';
  if (category) { filtered = filtered.filter((p) => p.category === category); titleExtra = ` / ${category}`; }
  if (tag) { filtered = filtered.filter((p) => p.tags.includes(tag)); titleExtra = ` / #${tag}`; }

  const totalPages = Math.ceil(filtered.length / pageSize) || 1;
  const categories = await readJSON(path.join(DIST_DIR, 'data', 'categories.json'));
  const tags = await readJSON(path.join(DIST_DIR, 'data', 'tags.json'));

  const baseDir = category
    ? path.join(DIST_DIR, 'categories', category.toLowerCase().replace(/\s+/g, '-'))
    : tag ? path.join(DIST_DIR, 'tags', tag.toLowerCase().replace(/\s+/g, '-')) : DIST_DIR;
  const baseDepth = (category || tag) ? 2 : 0;

  for (let p = 1; p <= totalPages; p++) {
    const pagePosts = filtered.slice((p - 1) * pageSize, p * pageSize);
    const pageDepth = baseDepth + (p > 1 ? 1 : 0);
    const rp = pageDepth === 0 ? '' : '../'.repeat(pageDepth);
    const prevPage = p > 1 ? (p === 2 ? 'index.html' : 'page/' + (p - 1) + '/index.html') : null;
    const nextPage = p < totalPages ? 'page/' + (p + 1) + '/index.html' : null;

    const html = await ejs.renderFile(
      path.join(LAYOUTS_DIR, 'index.ejs'),
      { site, posts: pagePosts, categories: categories || [], tags: tags || [],
        currentPage: p, totalPages, activeCategory: category || '', activeTag: tag || '',
        pageTitle: `${site.title}${titleExtra}`, relativePath: rp, prevPage, nextPage,
        t: _t, i18n: _i18n, lang: _lang },
      { views: [PARTIALS_DIR] }
    );

    const outDir = p > 1 ? path.join(baseDir, 'page', String(p)) : baseDir;
    await ensureDir(outDir);
    await writeFile(path.join(outDir, 'index.html'), html);
  }
}

/**
 * Render a post detail page
 */
async function renderPostPage(post, site, prev, next, related) {
  const categories = await readJSON(path.join(DIST_DIR, 'data', 'categories.json'));
  const tags = await readJSON(path.join(DIST_DIR, 'data', 'tags.json'));

  const html = await ejs.renderFile(
    path.join(LAYOUTS_DIR, 'post.ejs'),
    {
      site,
      post,
      categories: categories || [],
      tags: tags || [],
      prev: prev || null,
      next: next || null,
      related: related || [],
      pageTitle: `${post.title} - ${site.title}`,
      t: _t, i18n: _i18n, lang: _lang,
    },
    { views: [PARTIALS_DIR] }
  );

  const outDir = path.join(DIST_DIR, 'posts', post.slug);
  await ensureDir(outDir);
  await writeFile(path.join(outDir, 'index.html'), html);
}

export async function generatePages(allPosts, site) {
  log('Generating pages...');

  _i18n = await readJSON(path.join(SRC_DIR, 'data', 'i18n.json')) || {};
  _lang = site?.language || 'zh-CN';
  _t = (key) => (_i18n[key] && _i18n[key][_lang]) || (_i18n[key] && _i18n[key].en) || key;

  const posts = allPosts;

  // Homepage
  await renderListPage(posts, site, { pageNum: 1 });
  log('  /index.html');

  // Category pages
  const categories = await readJSON(path.join(DIST_DIR, 'data', 'categories.json'));
  if (categories) {
    for (const cat of categories) {
      await renderListPage(posts, site, { category: cat.name });
      log(`  /categories/${cat.slug}/index.html`);
    }
  }

  // Tag pages
  const tags = await readJSON(path.join(DIST_DIR, 'data', 'tags.json'));
  if (tags) {
    for (const tag of tags) {
      await renderListPage(posts, site, { tag: tag.name });
      log(`  /tags/${tag.slug}/index.html`);
    }
  }

  // Post pages (with prev/next + related)
  for (let i = 0; i < posts.length; i++) {
    const prev = i > 0 ? { slug: posts[i-1].slug, title: posts[i-1].title } : null;
    const next = i < posts.length - 1 ? { slug: posts[i+1].slug, title: posts[i+1].title } : null;
    // Related: posts sharing tags, sorted by count of shared tags
    const related = posts.filter(p => p.slug !== posts[i].slug && p.tags.some(t => posts[i].tags.includes(t)))
      .sort((a, b) => b.tags.filter(t => posts[i].tags.includes(t)).length - a.tags.filter(t => posts[i].tags.includes(t)).length)
      .slice(0, 3).map(p => ({ slug: p.slug, title: p.title, cover: p.cover }));
    await renderPostPage(posts[i], site, prev, next, related);
    log(`  /posts/${posts[i].slug}/index.html`);
  }

  // 404 page
  await render404Page(site);
  log('  /404.html');

  // Copy assets
  await copyDir(ASSETS_DIR, path.join(DIST_DIR, 'assets'));
  log('  Assets copied');

  log('Page generation complete');
}

async function render404Page(site) {
  const _site = site || { title: 'Mosaic' };
  const html = await ejs.renderFile(
    path.join(LAYOUTS_DIR, '404.ejs'),
    { site: _site, pageTitle: `404 - ${_site.title}`, t: _t, i18n: _i18n, lang: _lang },
    { views: [PARTIALS_DIR] }
  );
  await writeFile(path.join(DIST_DIR, '404.html'), html);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  generatePages([], { title: 'Test', pageSize: 12 }).catch(console.error);
}
