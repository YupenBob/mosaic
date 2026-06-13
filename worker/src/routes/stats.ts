/**
 * Stats route: GET /stats/dashboard
 * Returns aggregate statistics for the admin dashboard.
 */

import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { getLatestBuildStatus } from '../services/github';
import type { Env, DashboardStats } from '../types';

const stats = new Hono<{ Bindings: Env; Variables: { isAuthenticated: boolean } }>();

stats.use('*', authMiddleware);

/**
 * GET /stats/dashboard
 * Returns posts count, categories, tags, disk usage, and last build time.
 */
stats.get('/dashboard', async (c) => {
  // Count objects in R2 to estimate posts
  const originalsList = await c.env.MEDIA.list({ prefix: 'originals/', limit: 1000 });
  const processedList = await c.env.MEDIA.list({ prefix: 'processed/', limit: 1000 });

  // Extract unique slugs from object keys
  const slugs = new Set<string>();
  const categories = new Set<string>();

  for (const obj of originalsList.objects) {
    const parts = obj.key.split('/');
    if (parts.length >= 2 && parts[1]) {
      slugs.add(parts[1]);
    }
  }

  // Calculate disk usage
  let originalsSize = 0;
  let processedSize = 0;

  for (const obj of originalsList.objects) {
    originalsSize += obj.size || 0;
  }

  for (const obj of processedList.objects) {
    processedSize += obj.size || 0;
  }

  // Get last build status
  const lastBuild = await getLatestBuildStatus(c.env);

  const dashboard: DashboardStats = {
    posts: slugs.size,
    categories: categories.size,
    tags: 0, // Tags require reading Markdown which is in GitHub, not R2
    lastBuild: lastBuild?.updatedAt || null,
    diskUsage: {
      originals: originalsSize,
      processed: processedSize,
      total: originalsSize + processedSize,
    },
  };

  return c.json(dashboard);
});

export default stats;
