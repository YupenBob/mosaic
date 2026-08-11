/**
 * Taxonomy (categories/tags): stats, rename, delete.
 */
import { listPosts, renameCategory, renameTag, removeCategory, removeTag, markDirty } from '../github.js';
import { defer } from '../shared.js';

export function registerTaxonomy(app) {
  // Taxonomy
  app.get('/api/taxonomy', async (c) => {
    try {
      const posts = await listPosts(c);
      const cats = {},
        tags = {};
      posts.forEach((p) => {
        const c = p.category || 'uncategorized';
        cats[c] = (cats[c] || 0) + 1;
        (p.tags || []).forEach((t) => {
          tags[t] = (tags[t] || 0) + 1;
        });
      });
      return c.json({
        categories: Object.entries(cats).map(([n, c]) => ({ name: n, count: c })),
        tags: Object.entries(tags).map(([n, c]) => ({ name: n, count: c })),
      });
    } catch {
      return c.json({ categories: [], tags: [] });
    }
  });

  // Rename category (rewrites frontmatter in every affected post)
  app.put('/api/taxonomy/category', async (c) => {
    try {
      const { oldName, newName, message } = await c.req.json().catch(() => ({}));
      if (!oldName || !newName) return c.json({ error: 'oldName and newName required', code: 'INVALID_PARAMS' }, 400);
      const renamed = await renameCategory(c, oldName, newName, message);
      defer(c, () => markDirty(c.env));
      return c.json({ ok: true, renamed });
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });

  // Rename tag (rewrites frontmatter in every affected post)
  app.put('/api/taxonomy/tag', async (c) => {
    try {
      const { oldName, newName, message } = await c.req.json().catch(() => ({}));
      if (!oldName || !newName) return c.json({ error: 'oldName and newName required', code: 'INVALID_PARAMS' }, 400);
      const renamed = await renameTag(c, oldName, newName, message);
      defer(c, () => markDirty(c.env));
      return c.json({ ok: true, renamed });
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });

  // Delete category — remove it from every post that uses it
  app.delete('/api/taxonomy/category', async (c) => {
    try {
      const { name, message } = await c.req.json().catch(() => ({}));
      if (!name) return c.json({ error: 'name required', code: 'INVALID_PARAMS' }, 400);
      const affected = await removeCategory(c, name, message);
      defer(c, () => markDirty(c.env));
      return c.json({ ok: true, affected });
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });

  // Delete tag — remove it from every post that uses it
  app.delete('/api/taxonomy/tag', async (c) => {
    try {
      const { name, message } = await c.req.json().catch(() => ({}));
      if (!name) return c.json({ error: 'name required', code: 'INVALID_PARAMS' }, 400);
      const affected = await removeTag(c, name, message);
      defer(c, () => markDirty(c.env));
      return c.json({ ok: true, affected });
    } catch (e) {
      return c.json({ error: e.message, code: 'GITHUB_ERROR' }, 502);
    }
  });
}
