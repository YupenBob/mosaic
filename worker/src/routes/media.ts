/**
 * Media routes: GET /media/:slug/list, DELETE /media/:slug/:file
 * Lists and manages media files stored in R2.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { listMediaObjects, deleteObject } from '../services/r2';
import type { Env } from '../types';

const media = new Hono<{ Bindings: Env; Variables: { isAuthenticated: boolean } }>();

media.use('*', authMiddleware);

/**
 * GET /media/:slug/list
 * Lists all media files for a given post slug.
 */
media.get('/:slug/list', async (c) => {
  const slug = c.req.param('slug');
  const files = await listMediaObjects(c.env, slug);

  return c.json({
    slug,
    ...files,
  });
});

/**
 * DELETE /media/:slug/:file
 * Delete a specific media file. The file parameter should be URL-encoded.
 * Query parameters: ?type=photos|videos|music|covers&category=originals|processed
 */
media.delete('/:slug/:file', async (c) => {
  const slug = c.req.param('slug');
  const file = c.req.param('file');
  const type = c.req.query('type') || 'photos';
  const category = c.req.query('category') || 'originals';

  const key = `${category}/${slug}/${type}/${decodeURIComponent(file)}`;

  try {
    await deleteObject(c.env, key);
    return c.json({ ok: true, deleted: key });
  } catch (err) {
    return c.json({ error: 'Failed to delete file' }, 500);
  }
});

export default media;
