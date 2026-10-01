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
// ====== Contents API ======

async function listPostsUncached(c) {
  const resp = await fetch(contentsUrl(c, `content/posts`), { headers: headers(c) });
  if (!resp.ok) throw new Error(`GitHub listPosts: ${resp.status}`);
  const dirs = (await resp.json()).filter((f) => f.type === 'dir');
  return Promise.all(
    dirs.map(async (d) => {
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
          cover: fm.cover || '',
        };
      } catch {
        return { slug: d.name, title: d.name, cover: '' };
      }
    }),
  );
}

async function listPostsFromR2(c) {
  try {
    const obj =
      (await c.env.MEDIA.get('site-data/posts-index.json')) || (await c.env.MEDIA.get('site-data/posts.json'));
    if (!obj) return null;
    const posts = JSON.parse(await obj.text());
    if (!Array.isArray(posts)) return null;
    return posts.map((p) => ({
      slug: p.slug,
      title: p.title || p.slug,
      category: p.category,
      tags: p.tags || [],
      date: p.date,
      description: p.description,
      cover: p.cover || '',
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

export async function createOrUpdatePost(c, slug, frontMatter, body, message) {
  const existing = await getPost(c, slug);
  const yaml = Object.entries(frontMatter)
    .map(([k, v]) => (Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`))
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

async function deleteDir(c, dirPath, message) {
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
  const msg = message || `Delete ${slug}`;
  const count = await deleteDir(c, `content/posts/${slug}`, msg);
  bustCache();
  return { deleted: true, count };
}
