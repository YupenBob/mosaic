import {
  contentsUrl,
  branchPayload,
  headers,
  decodeBase64,
  encodeBase64,
  parseFrontMatter,
  cacheFor,
  bustCache,
} from './github-client.js';
import { getConfig } from './site-config.js';
import { isDirty } from './publication.js';
import { validSegment } from '../../../shared/media-manifest.mjs';

/** Reject unsafe or ambiguous post slugs before they reach GitHub/R2 paths. */
export function assertPostSlug(slug) {
  if (!validSegment(slug)) {
    const error = new Error('Invalid post slug');
    error.status = 400;
    error.code = 'INVALID_PARAMS';
    throw error;
  }
  return slug;
}
// ====== Contents API ======

async function readPostsIndex(c) {
  try {
    const obj =
      (await c.env.MEDIA.get('site-data/posts-index.json')) || (await c.env.MEDIA.get('site-data/posts.json'));
    if (!obj) return null;
    const posts = JSON.parse(await obj.text());
    return Array.isArray(posts) ? posts : null;
  } catch {
    return null;
  }
}

async function listPostsUncached(c) {
  const resp = await fetch(contentsUrl(c, `content/posts`), { headers: headers(c) });
  if (!resp.ok) throw new Error(`GitHub listPosts: ${resp.status}`);
  const dirs = (await resp.json()).filter((f) => f.type === 'dir');
  // The build-time index carries resolved cover URLs, LQIP and aspect ratios.
  // Use it as a fallback even while dirty so edited posts keep a thumbnail;
  // frontmatter remains the source of truth for text fields.
  const index = await readPostsIndex(c);
  const indexBySlug = new Map((index || []).map((post) => [post.slug, post]));
  return Promise.all(
    dirs.map(async (d) => {
      const cached = indexBySlug.get(d.name) || {};
      try {
        const mdResp = await fetch(contentsUrl(c, `content/posts/${d.name}/index.md`), { headers: headers(c) });
        if (!mdResp.ok) return { slug: d.name, title: d.name };
        const md = await mdResp.json();
        const content = decodeBase64(md.content);
        const fm = parseFrontMatter(content);
        return {
          slug: d.name,
          title: fm.title || d.name,
          category: fm.category,
          tags: fm.tags || [],
          date: fm.date,
          description: fm.description,
          media: fm.media || null,
          cover: fm.cover || '',
          ...(cached.cover ? { coverResolved: cached.cover } : {}),
          ...(cached.coverLqip ? { coverLqip: cached.coverLqip } : {}),
          ...(cached.coverAspect ? { coverAspect: cached.coverAspect } : {}),
          ...(cached.coverSrcset ? { coverSrcset: cached.coverSrcset } : {}),
        };
      } catch {
        return { slug: d.name, title: d.name, cover: '' };
      }
    }),
  );
}

async function listPostsFromR2(c) {
  try {
    const posts = await readPostsIndex(c);
    if (!posts) return null;
    return posts.map((p) => ({
      slug: p.slug,
      title: p.title || p.slug,
      category: p.category,
      tags: p.tags || [],
      date: p.date,
      description: p.description,
      media: p.media || null,
      cover: p.cover || '',
      ...(p.coverLqip ? { coverLqip: p.coverLqip } : {}),
      ...(p.coverAspect ? { coverAspect: p.coverAspect } : {}),
      ...(p.coverSrcset ? { coverSrcset: p.coverSrcset } : {}),
      ...(p.type ? { type: p.type } : {}),
      ...(p.stats ? { stats: p.stats } : {}),
    }));
  } catch {
    return null;
  }
}

export async function listPosts(c) {
  const cache = cacheFor(c.env);
  const config = await getConfig(c);
  if (cache.posts && Date.now() - cache.postsTime < config.cache.postsMs) return cache.posts;
  let fresh = null;
  // Prefer the build-time R2 cache (fast, no GitHub rate-limit cost). Fall
  // back to GitHub when there are unbuilt changes (dirty) or the cache is missing.
  try {
    const dirty = await isDirty(c.env);
    if (!dirty || (c.env.JOBS ? !dirty.contentDirty : !dirty.count)) fresh = await listPostsFromR2(c);
  } catch {}
  if (!fresh) fresh = await listPostsUncached(c);
  cache.posts = fresh;
  cache.postsTime = Date.now();
  return fresh;
}

export async function getPost(c, slug) {
  const resp = await fetch(contentsUrl(c, `content/posts/${slug}/index.md`), {
    headers: headers(c),
  });
  if (!resp.ok) return null;
  const md = await resp.json();
  const content = decodeBase64(md.content);
  const fm = parseFrontMatter(content);
  const body = content.replace(/^---[\s\S]*?---\n?/, '').trim();
  return { slug, frontMatter: fm, body, sha: md.sha };
}

function yamlValue(value) {
  if (value === null || value === undefined) return 'null';
  // JSON is a YAML 1.2 subset and handles nested `media`/`player` objects
  // without writing "[object Object]" or losing array quoting.
  if (typeof value === 'object' || Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

export async function createOrUpdatePost(c, slug, frontMatter, body, message, baseSha) {
  assertPostSlug(slug);
  const existing = await getPost(c, slug);
  // Optimistic concurrency: admin sends the blob SHA it loaded. `null` means
  // "this is a new post", so an existing slug is a conflict instead of an
  // accidental overwrite. Omitting the field keeps the legacy API behavior.
  if (baseSha !== undefined) {
    if (baseSha === null && existing) {
      const error = new Error(`Post ${slug} already exists`);
      error.status = 409;
      error.code = 'SLUG_CONFLICT';
      throw error;
    }
    if (baseSha !== null && (!existing || existing.sha !== baseSha)) {
      const error = new Error(`Post ${slug} changed since it was loaded`);
      error.status = 409;
      error.code = 'CONFLICT';
      throw error;
    }
  }
  const yaml = Object.entries(frontMatter)
    .filter(([key]) => /^[A-Za-z0-9_-]+$/.test(key))
    .map(([key, value]) => `${key}: ${yamlValue(value)}`)
    .join('\n');
  const content = `---\n${yaml}\n---\n\n${body || ''}`;
  const endpoint = contentsUrl(c, `content/posts/${slug}/index.md`);
  const payload = { ...branchPayload(c), message: message || `Update ${slug}`, content: encodeBase64(content) };
  if (existing?.sha) payload.sha = existing.sha;
  const resp = await fetch(endpoint, {
    method: 'PUT',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`GitHub createPost(${slug}): ${resp.status}`);
  bustCache();
  return resp.json();
}

function assertContentPath(pathname) {
  if (pathname !== 'content/posts' && !pathname.startsWith('content/posts/'))
    throw Object.assign(new Error('Refusing to delete outside content/posts'), { status: 400 });
  if (pathname.includes('..') || pathname.includes('//'))
    throw Object.assign(new Error('Invalid content path'), { status: 400 });
}

async function deleteDir(c, dirPath, message) {
  assertContentPath(dirPath);
  const resp = await fetch(contentsUrl(c, `${dirPath}`), { headers: headers(c) });
  if (!resp.ok) return 0;
  const items = await resp.json();
  let count = 0;
  for (const item of Array.isArray(items) ? items : [items]) {
    if (item.type === 'dir') {
      count += await deleteDir(c, item.path, message);
    } else {
      const delResp = await fetch(contentsUrl(c, `${item.path}`), {
        method: 'DELETE',
        headers: { ...headers(c), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...branchPayload(c), message, sha: item.sha }),
      });
      if (delResp.ok) count++;
    }
  }
  return count;
}

export async function deletePost(c, slug, message) {
  assertPostSlug(slug);
  const msg = message || `Delete ${slug}`;
  const count = await deleteDir(c, `content/posts/${slug}`, msg);
  bustCache();
  return { deleted: true, count };
}
