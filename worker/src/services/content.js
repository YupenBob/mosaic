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
import { assertValidFrontmatter } from '../../../shared/content-schema.mjs';
import {
  applyContentOverlay,
  readContentOverlay,
  upsertContentOverlay,
  removeFromContentOverlay,
} from './content-overlay.mjs';

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

/** Normalise a build-index entry (or parsed frontmatter) into a listPosts record. */
export function postRecord(slug, source = {}, extras = {}) {
  return {
    slug,
    title: source.title || slug,
    category: source.category,
    tags: Array.isArray(source.tags) ? source.tags : [],
    date: source.date,
    description: source.description,
    media: source.media || null,
    cover: source.cover || '',
    ...(extras.coverLqip ? { coverLqip: extras.coverLqip } : {}),
    ...(extras.coverAspect ? { coverAspect: extras.coverAspect } : {}),
    ...(extras.coverSrcset ? { coverSrcset: extras.coverSrcset } : {}),
    ...(source.type ? { type: source.type } : {}),
    ...(source.stats ? { stats: source.stats } : {}),
  };
}

/** The build-time index entries mapped to the listPosts record shape. */
function indexRecords(index) {
  return (index || [])
    .filter((post) => post && typeof post.slug === 'string')
    .map((post) => postRecord(post.slug, post, post));
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

/**
 * List posts from the build-time R2 index plus the content overlay.
 *
 * - index + overlay          → merge (no GitHub call at all)
 * - index, no overlay, clean → index as-is
 * - index, no overlay, dirty → full GitHub read (legacy behaviour: without an
 *                              overlay we cannot know what changed)
 * - overlay.refresh          → full GitHub read (change not expressible)
 * - no index at all          → full GitHub read
 */
export async function listPosts(c) {
  const cache = cacheFor(c.env);
  const config = await getConfig(c);
  if (cache.posts && Date.now() - cache.postsTime < config.cache.postsMs) return cache.posts;
  let fresh = null;
  try {
    const index = await readPostsIndex(c);
    if (index) {
      const dirty = await isDirty(c.env);
      const contentDirty = c.env.JOBS ? !!dirty?.contentDirty : !!dirty?.count;
      const overlay = await readContentOverlay(c);
      if (overlay && !overlay.refresh) fresh = applyContentOverlay(indexRecords(index), overlay);
      else if (!overlay && !contentDirty) fresh = indexRecords(index);
    }
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
  // Shared schema (build scripts use the same rules): unsafe categories/tags
  // must fail here, before they reach Git or the content overlay.
  try {
    assertValidFrontmatter(frontMatter && typeof frontMatter === 'object' ? frontMatter : {}, { slug });
  } catch (error) {
    const invalid = Object.assign(new Error(error.message), { status: 422, code: 'INVALID_CONTENT' });
    throw invalid;
  }
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
  const result = await resp.json();
  // Layer the save over the build-time index. Best-effort: if the overlay write
  // fails, the dirty flag (set by the route) still routes listPosts through the
  // authoritative GitHub read.
  try {
    const index = await readPostsIndex(c);
    const cached = (index || []).find((post) => post.slug === slug) || {};
    await upsertContentOverlay(c, [
      postRecord(
        slug,
        {
          title: frontMatter.title ?? cached.title,
          category: frontMatter.category ?? cached.category,
          tags: Array.isArray(frontMatter.tags) ? frontMatter.tags : cached.tags,
          date: frontMatter.date ?? cached.date,
          description: frontMatter.description ?? cached.description,
          media: frontMatter.media ?? cached.media,
          cover: frontMatter.cover ?? cached.cover,
          type: cached.type,
          stats: cached.stats,
        },
        cached,
      ),
    ]);
  } catch (error) {
    console.error(`content overlay upsert failed for ${slug} (falling back to GitHub reads):`, error?.message || error);
  }
  return result;
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
  try {
    await removeFromContentOverlay(c, [slug]);
  } catch (error) {
    console.error(`content overlay remove failed for ${slug} (falling back to GitHub reads):`, error?.message || error);
  }
  return { deleted: true, count };
}

/**
 * Fresh listPosts record for one post, read from GitHub and enriched with the
 * build-index cover metadata. Used by write paths that cannot build the record
 * from the request body (e.g. history restore).
 */
export async function snapshotPostForOverlay(c, slug) {
  const post = await getPost(c, slug);
  if (!post) return null;
  const index = await readPostsIndex(c);
  const cached = (index || []).find((entry) => entry.slug === slug) || {};
  return postRecord(
    slug,
    {
      title: post.frontMatter.title ?? cached.title,
      category: post.frontMatter.category ?? cached.category,
      tags: Array.isArray(post.frontMatter.tags) ? post.frontMatter.tags : cached.tags,
      date: post.frontMatter.date ?? cached.date,
      description: post.frontMatter.description ?? cached.description,
      media: post.frontMatter.media ?? cached.media,
      cover: post.frontMatter.cover ?? cached.cover,
      type: cached.type,
      stats: cached.stats,
    },
    cached,
  );
}
