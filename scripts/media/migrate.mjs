import { loadContext } from '../lib/context.mjs';
import { createPipelineClient } from '../lib/pipeline-client.mjs';
import { createStorage } from './storage.mjs';
import { migrateLegacy } from './legacy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { validSegment } from '../../shared/media-manifest.mjs';
if (!process.env.GITHUB_RUN_ID) throw new Error('Media migration must run in GitHub Actions');
const { config, content } = loadContext(),
  store = createStorage(config),
  request = createPipelineClient();
const marker = 'site-data/media-migration-v1.json';
if (!(await store.head(marker))) {
  let checksums = {};
  if (await store.head('site-data/media-checksums.json'))
    checksums = JSON.parse(await (await store.get('site-data/media-checksums.json')).text());
  const coverNames = {};
  for (const slug of fs.readdirSync(content)) {
    const file = path.join(content, slug, 'index.md');
    if (!fs.existsSync(file)) continue;
    const cover = matter(fs.readFileSync(file, 'utf8')).data.cover;
    if (validSegment(cover) && !/^(https?:|photo:|video:)/.test(cover)) coverNames[slug] = cover;
  }
  const manifest = await migrateLegacy(store, config, checksums, coverNames);
  await request('media/import', { manifest, config, previousGitSha: process.env.MIGRATION_GIT_SHA || '' });
  await store.putJSON(marker, { completedAt: new Date().toISOString(), assets: Object.keys(manifest.assets).length });
  console.log(`Migrated ${Object.keys(manifest.assets).length} media entries`);
} else console.log('Legacy media migration already complete');
