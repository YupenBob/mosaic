/**
 * Admin utilities: dirty state, trash stub, disk usage, orphan cleanup,
 * processed cache reset.
 */
import { isDirty, listPosts } from '../github.js';
import { invalidateUsageSnapshot } from '../usage.js';
import { getDiskUsage, scanOrphans } from '../shared.js';

export function registerAdmin(app) {
  // Dirty state query
  app.get('/api/dirty', async (c) => {
    const dirty = await isDirty(c.env);
    return c.json(dirty || { count: 0 });
  });

  // Trash (stub — GitHub doesn't have trash, return empty)
  app.get('/api/trash', (c) => c.json([]));

  app.get('/api/disk', async (c) => {
    try {
      const { size: totalSize, objects: totalObjects } = await getDiskUsage(c.env);
      const GB = totalSize / 1024 / 1024 / 1024;
      const cost = (GB * 0.015).toFixed(2); // R2 storage: $0.015/GB/month
      return c.json({
        size: totalSize,
        sizeMB: (totalSize / 1024 / 1024).toFixed(1),
        sizeGB: GB.toFixed(2),
        objects: totalObjects,
        cost: cost,
        currency: 'USD',
      });
    } catch (e) {
      return c.json({ error: e.message, code: 'R2_ERROR' }, 502);
    }
  });

  app.get('/api/cleanup', async (c) => {
    try {
      const posts = await listPosts(c).catch(() => []);
      const valid = new Set(posts.map((p) => p.slug));
      const { orphans } = await scanOrphans(c.env, valid, 'list');
      const total = orphans.reduce((a, o) => a + o.size, 0);
      return c.json({ orphans, totalSize: total, totalOrphans: orphans.length });
    } catch (e) {
      return c.json({ error: e.message }, 502);
    }
  });

  app.delete('/api/cleanup', async (c) => {
    try {
      const posts = await listPosts(c).catch(() => []);
      const valid = new Set(posts.map((p) => p.slug));
      const { deleted, freed } = await scanOrphans(c.env, valid, 'delete');
      return c.json({ deleted, freed, freedMB: (freed / 1048576).toFixed(1) });
    } catch (e) {
      return c.json({ error: e.message }, 502);
    }
  });

  // Processed cache cleanup — delete all processed/ objects from R2
  app.delete('/api/processed-cache', async (c) => {
    try {
      let deleted = 0,
        freed = 0,
        cursor;
      do {
        const opts = { prefix: 'processed/', limit: 500 };
        if (cursor) opts.cursor = cursor;
        const list = await c.env.MEDIA.list(opts);
        for (const obj of list.objects || []) {
          await c.env.MEDIA.delete(obj.key);
          deleted++;
          freed += obj.size;
        }
        cursor = list.truncated ? list.cursor : null;
      } while (cursor);
      if (deleted > 0) await invalidateUsageSnapshot(c.env);
      return c.json({ deleted, freed, freedMB: (freed / 1048576).toFixed(1) });
    } catch (e) {
      return c.json({ error: e.message, code: 'R2_ERROR' }, 502);
    }
  });
}
