/**
 * Target environments for UX journeys.
 *
 *  local        full 14-post site generated from the published media manifest,
 *               served from .mosaic/qa/site (media still loads from production,
 *               read-only)
 *  prod         the live Pages site (real stats writes allowed, keep them rare)
 *  admin-local  the staged admin panel with mocked API routes per journey
 *  admin-prod   the live admin panel, forced read-only by a route guard
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../../../scripts/lib/context.mjs';
import { stageAdmin } from '../../../scripts/lib/published-assets.mjs';
import { serveDirectory } from '../../helpers/static-server.mjs';

export const PROD = {
  site: 'https://mosaic.xsanye.cn',
  api: 'https://mosaic-api.xsanye.cn',
  media: 'https://mosaic-media.xsanye.cn',
  admin: 'https://mosaic-admin.xsanye.cn',
};

export function localSiteDirectory() {
  return path.join(ROOT, '.mosaic/qa/site');
}

/** Serve the QA build, generating it first when missing (or QA_REBUILD=1). */
export async function startLocalSite() {
  const directory = localSiteDirectory();
  if (!fs.existsSync(path.join(directory, 'index.html')) || process.env.QA_REBUILD === '1') {
    const { buildLocalSite } = await import('../../../scripts/qa/build-local.mjs');
    await buildLocalSite({ refresh: process.env.QA_REFRESH === '1' });
  }
  const server = await serveDirectory(directory);
  return { base: server.url, close: server.close, directory };
}

/** Stage the admin bundle into a temp dir and serve it statically. */
export async function startLocalAdmin() {
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-qa-admin-'));
  const dist = path.join(staged, 'dist');
  stageAdmin(path.join(ROOT, 'cloud-admin'), dist, ROOT);
  const server = await serveDirectory(dist);
  return { base: server.url, close: server.close, directory: dist, config: {} };
}
