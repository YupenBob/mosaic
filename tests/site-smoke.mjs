import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSite } from '../scripts/site/generate.mjs';
import { loadContext, ROOT } from '../scripts/lib/context.mjs';
import { emptyManifest, assetId } from '../shared/media-manifest.mjs';

/**
 * Whole-site smoke test: manifest-only generation, pending slots, deep
 * categories, taxonomy routes, escaping, feed/sitemap well-formedness and the
 * hard-fail gates for unsafe frontmatter.
 */

// Full article records (data/posts.json) are a debug artifact gated behind
// MOSAIC_DEBUG_DATA; this test is one of its consumers.
const previousDebugData = process.env.MOSAIC_DEBUG_DATA;
process.env.MOSAIC_DEBUG_DATA = '1';

const tempRoots = [];
function tempRoot(prefix = 'mosaic-site-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeFile(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** YAML frontmatter fixture (JSON strings are valid YAML double-quoted scalars). */
function markdown({ title = 'Post', date, category, tags = [], description, body = 'Body' } = {}) {
  const lines = ['---', `title: ${JSON.stringify(title)}`];
  if (date) lines.push(`date: ${date}`);
  if (category !== undefined) lines.push(`category: ${JSON.stringify(category)}`);
  lines.push(`tags: ${JSON.stringify(tags)}`);
  if (description !== undefined) lines.push(`description: ${JSON.stringify(description)}`);
  lines.push('---', '', body, '');
  return lines.join('\n');
}

function makeSite(posts, config = {}) {
  const root = tempRoot();
  fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  writeFile(
    root,
    'mosaic.config.json',
    JSON.stringify({
      title: 'Fixture',
      url: 'https://site.test',
      mediaBase: 'https://media.test',
      apiBase: '/api',
      ...config,
    }),
  );
  writeFile(root, '.mosaic/media-manifest.json', JSON.stringify(emptyManifest()));
  for (const [slug, content] of Object.entries(posts)) writeFile(root, `content/posts/${slug}/index.md`, content);
  return { root, context: loadContext({ MOSAIC_ROOT: root }) };
}

/**
 * Strict-enough XML well-formedness check (no XML parser dependency):
 * balanced tags, balanced CDATA sections and no bare `&` outside entities/CDATA.
 * @param {string} xml
 * @param {string} label
 */
function assertWellFormedXml(xml, label) {
  assert.ok(xml.startsWith('<?xml'), `${label}: missing XML declaration`);
  const cdataCount = (xml.match(/<!\[CDATA\[/g) || []).length;
  const cdataEndCount = (xml.match(/\]\]>/g) || []).length;
  assert.equal(cdataCount, cdataEndCount, `${label}: unbalanced CDATA sections`);
  const outsideCdata = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(outsideCdata), `${label}: raw "&" outside CDATA`);
  const tokens =
    xml.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*?)?\/?>/g) || [];
  const stack = [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<![CDATA[')) continue;
    const close = /^<\/([A-Za-z][\w:.-]*)\s*>$/.exec(token);
    if (close) {
      assert.equal(stack.pop(), close[1], `${label}: mismatched </${close[1]}>`);
      continue;
    }
    if (/\/>$/.test(token)) continue;
    const open = /^<([A-Za-z][\w:.-]*)/.exec(token);
    stack.push(open[1]);
  }
  assert.deepEqual(stack, [], `${label}: unclosed tags ${stack.join(',')}`);
}

try {
  // ── Scenario 1: manifest-only generation (historical contract) ──
  const root = tempRoot();
  fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'content/posts/post'), { recursive: true });
  fs.mkdirSync(path.join(root, '.mosaic'));
  fs.writeFileSync(
    path.join(root, 'mosaic.config.json'),
    JSON.stringify({
      title: 'Fixture',
      url: 'https://site.test',
      mediaBase: 'https://media.test',
      apiBase: '/api',
      pageSize: 1,
    }),
  );
  fs.writeFileSync(
    path.join(root, 'content/posts/post/index.md'),
    '---\ntitle: Post\ncategory: parent/child/grandchild\ntags: [test]\n---\n\n{{video:0}}\n\nBody\n\n{{photo:0}}\n',
  );
  const manifest = emptyManifest();
  manifest.revision = 7;
  const add = (folder, filename, published = null) => {
    const id = assetId('post', filename, folder);
    manifest.assets[id] = { id, slug: 'post', filename, folder, status: published ? 'ready' : 'pending', published };
  };
  add('videos', 'a.mp4');
  add('videos', 'b.mp4', {
    poster: 'processed/post/videos/v1/poster.jpg',
    posterPreview: 'processed/post/videos/v1/poster-preview.webp',
    hls: 'processed/post/videos/v1/master.m3u8',
    sources: { '240p': 'processed/post/videos/v1/240p.mp4' },
  });
  add('photos', 'a.jpg', {
    original: 'processed/post/photos/v1/original.png',
    placeholder: 'processed/post/photos/v1/placeholder.webp',
    variants: { '480p': 'processed/post/photos/v1/480p.webp' },
    aspect: 1.5,
  });
  add('music', 'a.flac', {
    sources: { '128k': 'processed/post/music/v1/128k.mp3' },
    waveform: Array(400).fill(0.5),
    duration: 1,
  });
  fs.writeFileSync(path.join(root, '.mosaic/media-manifest.json'), JSON.stringify(manifest));
  const context = loadContext({ MOSAIC_ROOT: root });
  const result = generateSite(context);
  assert.equal(result.mediaRevision, 7);
  assert.ok(!fs.existsSync(path.join(root, 'content/posts/post/videos')), 'build must not need local originals');
  assert.ok(!fs.existsSync(path.join(context.dist, '.media-checksums.json')));
  const listing = JSON.parse(fs.readFileSync(path.join(context.dist, 'data/posts-index.json')));
  assert.equal(listing.length, 1);
  assert.ok(!('bodyHTML' in listing[0]) && !('music' in listing[0]) && !('videos' in listing[0]));
  assert.ok(
    listing[0].coverLqip.startsWith('https://media.test/processed/post/videos/v1/poster-preview.webp'),
    'listing exposes the few-KB cover LQIP',
  );
  const posts = JSON.parse(fs.readFileSync(path.join(context.dist, 'data/posts.json')));
  assert.equal(posts[0].videos[0].pending, true, 'pending media preserve positional references');
  assert.ok(posts[0].videos[1].hls.startsWith('https://media.test/processed/'));
  const html = fs.readFileSync(path.join(context.dist, 'posts/post/index.html'), 'utf8');
  assert.match(html, /media-pending/);
  assert.ok(!html.includes('undefined'), 'no speculative media URLs');
  const home = fs.readFileSync(path.join(context.dist, 'index.html'), 'utf8');
  assert.match(home, /post-card-img is-lqip/, 'cards ship an LQIP first');
  assert.match(
    home,
    /data-src="https:\/\/media.test\/processed\/post\/videos\/v1\/poster.jpg"/,
    'HD URL waits in data-src',
  );
  assert.match(home, /--cover-aspect:/, 'per-card aspect reserves height for masonry');
  assert.ok(fs.existsSync(path.join(context.dist, 'categories/parent/child/grandchild/index.html')));
  assert.match(
    html,
    /href="\.\.\/\.\.\/categories\/parent\/child\/grandchild\/"/,
    'existing nested category route stays unchanged in breadcrumb/category links',
  );
  assert.match(html, /<script type="application\/ld\+json">/);
  fs.writeFileSync(path.join(context.dist, 'stale.html'), 'stale');
  generateSite(context);
  assert.ok(!fs.existsSync(path.join(context.dist, 'stale.html')), 'deleted pages must not survive rebuild');
  const same = JSON.parse(fs.readFileSync(path.join(context.dist, 'data/posts-index.json')));
  assert.deepEqual(listing, same, 'same content and manifest produce the same index');
  manifest.assets['post/videos/a.mp4'].published = manifest.assets['post/videos/b.mp4'].published;
  manifest.assets['post/videos/a.mp4'].status = 'processing';
  fs.writeFileSync(context.manifestPath, JSON.stringify(manifest));
  generateSite(context);
  const replaced = JSON.parse(fs.readFileSync(path.join(context.dist, 'data/posts.json')));
  assert.equal(replaced[0].videos[0].pending, undefined, 'a replacement continues using its published version');
  assert.throws(() => generateSite({ ...context, dist: root }), /Unsafe site output/);

  // ── Scenario 2: nested/spaced taxonomy route, escaping, feed & sitemap ──
  const trickyTitle = 'A <B> & ]]> </script> title';
  const trickyDescription = 'Desc < > & ]]> </script> "quoted"';
  const nested = makeSite({
    'tech-note': markdown({
      title: trickyTitle,
      date: '2026-01-02T00:00:00.000Z',
      category: 'Tech / Web',
      tags: ['Web 开发', 'C++', 'C#'],
      description: trickyDescription,
    }),
    plain: markdown({ title: 'Plain', date: '2026-01-01T00:00:00.000Z', tags: ['gif'] }),
  });
  // Inline i18n must escape "<" so translated text can never close the tag.
  writeFile(
    nested.root,
    'src/data/i18n.json',
    JSON.stringify({ home: '</script><script>alert(1)</script>', built_with: 'Built' }),
  );
  generateSite(nested.context);
  const { dist } = nested.context;
  const postsRoot = path.join(dist, 'posts', 'tech-note', 'index.html');
  const nestedHtml = fs.readFileSync(postsRoot, 'utf8');
  const tagPage = (slug) => path.join(dist, 'tags', slug, 'index.html');
  const catPage = (route) => path.join(dist, 'categories', route, 'index.html');

  assert.ok(fs.existsSync(catPage('tech/web')), '"Tech / Web" builds categories/tech/web/index.html');
  assert.ok(!fs.existsSync(catPage('tech-/-web')), 'old broken spaced-slug route is not emitted');
  // The breadcrumb href must be the same route the category page was written to.
  const breadcrumbHref = /<nav class="post-breadcrumb"[\s\S]*?<a href="([^"]*categories\/[^"]*)"/.exec(nestedHtml)[1];
  assert.equal(breadcrumbHref, '../../categories/tech/web/');
  assert.ok(
    fs.existsSync(path.join(path.resolve(path.dirname(postsRoot), breadcrumbHref), 'index.html')),
    'breadcrumb route resolves to a built category page',
  );
  assert.equal(
    (nestedHtml.match(/href="\.\.\/\.\.\/categories\/tech\/web\/"/g) || []).length,
    3,
    'breadcrumb, category and meta links all use the unified route',
  );
  assert.match(nestedHtml, /<h1 class="post-title">A &lt;B&gt; &amp; ]]&gt; &lt;\/script&gt; title<\/h1>/);

  // JSON-LD must be parseable JSON and must not break out of its script tag.
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(nestedHtml);
  assert.ok(ld, 'post page ships JSON-LD');
  assert.ok(!ld[1].includes('</script>'), 'JSON-LD must not contain a raw closing script tag');
  const structured = JSON.parse(ld[1]);
  assert.equal(structured.headline, trickyTitle);
  assert.equal(structured.description, trickyDescription);
  assert.equal(structured.url, 'https://site.test/posts/tech-note/');
  const i18nAssign = nestedHtml.slice(nestedHtml.indexOf('window.__I18N='));
  const inlineI18n = i18nAssign.slice('window.__I18N='.length, i18nAssign.indexOf(';window.__LANG'));
  assert.ok(!inlineI18n.includes('</script>'), 'inline i18n must escape "<"');
  assert.equal(JSON.parse(inlineI18n).home, '</script><script>alert(1)</script>');

  // Tag pages exist for CJK / symbol tags and are reachable by their slug.
  assert.ok(fs.existsSync(tagPage('web-开发')), 'CJK tag page built');
  assert.ok(fs.existsSync(tagPage('c++')), '"C++" tag page built');
  assert.ok(fs.existsSync(tagPage('c#')), '"C#" tag page built');

  // Feed: CDATA-safe and well-formed, including a title containing "]]>".
  const feed = fs.readFileSync(path.join(dist, 'feed.xml'), 'utf8');
  assertWellFormedXml(feed, 'feed.xml');
  assert.equal((feed.match(/<item>/g) || []).length, 2);
  assert.ok(feed.includes(']]]]><![CDATA[>'), 'RSS CDATA splits a literal "]]>" instead of ending the section');
  assert.ok(feed.includes('https://site.test/posts/tech-note/'));

  // Sitemap: well-formed and percent-encoded for non-ASCII taxonomy routes.
  const sitemap = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
  assertWellFormedXml(sitemap, 'sitemap.xml');
  assert.ok(sitemap.includes('https://site.test/categories/tech/web/'));
  assert.ok(
    sitemap.includes(`https://site.test/tags/${encodeURIComponent('web-开发')}/`),
    'sitemap percent-encodes CJK tag routes',
  );
  assert.ok(sitemap.includes(`https://site.test/tags/${encodeURIComponent('c#')}/`), 'sitemap encodes "#"');

  // ── Scenario 3: unsafe taxonomy hard-fails the build ──
  const dotdotTag = makeSite({ evil: markdown({ tags: ['..'] }) });
  assert.throws(() => generateSite(dotdotTag.context), /tag "\.\."|not a safe tag/i);
  assert.ok(!fs.existsSync(path.join(dotdotTag.context.dist, 'tags')), 'no dist written for a rejected taxonomy');

  const traversalTag = makeSite({ evil: markdown({ tags: ['a/../../index'] }) });
  assert.throws(() => generateSite(traversalTag.context), /tag .*"/i);

  const dotdotCategory = makeSite({ evil: markdown({ category: 'a/../b' }) });
  assert.throws(() => generateSite(dotdotCategory.context), /category .*not a safe category/i);

  const emptyCategorySegment = makeSite({ evil: markdown({ category: 'a//b' }) });
  assert.throws(() => generateSite(emptyCategorySegment.context), /empty path segments/i);

  console.log(
    'Site smoke: manifest-only generation, pending slots, previous versions, thin index, deep categories, taxonomy routes, escaping, JSON-LD, RSS/sitemap encoding and unsafe-taxonomy rejection passed',
  );
} finally {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
  if (previousDebugData === undefined) delete process.env.MOSAIC_DEBUG_DATA;
  else process.env.MOSAIC_DEBUG_DATA = previousDebugData;
}
