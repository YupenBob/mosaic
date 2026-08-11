/**
 * Posts CRUD + duplicate.
 */
import { listPosts, getPost, createOrUpdatePost, deletePost, markDirty } from '../github.js';
import { invalidateUsageSnapshot } from '../usage.js';
import { defer } from '../shared.js';

export function registerPosts(app) {
  // Posts CRUD
  app.get('/api/posts', async (c) => {
    try {
      const posts = await listPosts(c);
      const limit = Math.min(Math.max(parseInt(c.req.query('limit')) || 0, 0), 500);
      const cursor = c.req.query('cursor') || '';
      if (!limit) return c.json({ posts, total: posts.length });
      const start = cursor ? posts.findIndex((p) => p.slug === cursor) + 1 : 0;
      if (start < 0) return c.json({ posts: [], total: posts.length, nextCursor: null });
      const page = posts.slice(start, start + limit);
      const nextCursor = start + limit < posts.length ? posts[Math.min(start + limit, posts.length - 1)].slug : null;
      return c.json({ posts: page, total: posts.length, nextCursor });
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });

  app.get('/api/posts/:slug', async (c) => {
    try {
      const post = await getPost(c, c.req.param('slug'));
      if (!post) return c.json({ error: 'Post not found', code: 'NOT_FOUND' }, 404);
      return c.json(post);
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });

  app.post('/api/posts', async (c) => {
    try {
      const { slug, frontMatter, body, message } = await c.req.json();
      if (!slug) return c.json({ error: 'slug required', code: 'INVALID_PARAMS' }, 400);
      const result = await createOrUpdatePost(c, slug, frontMatter, body, message);
      defer(c, () => markDirty(c.env));
      return c.json({ ok: true, slug, sha: result.content?.sha }, 201);
    } catch (e) {
      return c.json(
        { error: e.message, code: e.message.includes('exists') ? 'SLUG_CONFLICT' : 'GITHUB_ERROR' },
        e.message.includes('exists') ? 409 : 502,
      );
    }
  });

  app.delete('/api/posts/:slug', async (c) => {
    try {
      const slug = c.req.param('slug');
      const { message } = await c.req.json().catch(() => ({}));

      // Delete from GitHub
      const result = await deletePost(c, slug, message);

      // Delete from R2 (originals + processed)
      let r2Count = 0;
      for (const prefix of ['originals', 'processed']) {
        let cursor;
        do {
          try {
            const opts = { prefix: `${prefix}/${slug}/`, limit: 1000 };
            if (cursor) opts.cursor = cursor;
            const list = await c.env.MEDIA.list(opts);
            for (const obj of list.objects || []) {
              await c.env.MEDIA.delete(obj.key);
              r2Count++;
            }
            cursor = list.truncated ? list.cursor : null;
          } catch {
            cursor = null;
          }
        } while (cursor);
      }
      if (r2Count > 0) result.r2Deleted = r2Count;
      if (r2Count > 0) await invalidateUsageSnapshot(c.env);

      defer(c, () => markDirty(c.env));
      return c.json(result);
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });

  // Duplicate post
  app.post('/api/posts/:slug/duplicate', async (c) => {
    try {
      const post = await getPost(c, c.req.param('slug'));
      if (!post) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
      const { newSlug } = await c.req.json().catch(() => ({}));
      const slug = newSlug || `${c.req.param('slug')}-copy`;
      await createOrUpdatePost(c, slug, post.frontMatter, post.body, `Duplicate ${c.req.param('slug')} → ${slug}`);
      defer(c, () => markDirty(c.env));
      return c.json({ ok: true, slug });
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });
}
