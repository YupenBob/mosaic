import { loadContext } from '../lib/context.mjs';
import { createPipelineClient } from '../lib/pipeline-client.mjs';
import { createStorage } from './storage.mjs';
import { migrateLegacy } from './legacy.mjs';
if (!process.env.GITHUB_RUN_ID) throw new Error('Media migration must run in GitHub Actions');
const { config } = loadContext(),
  store = createStorage(config),
  request = createPipelineClient();
const marker = 'site-data/media-migration-v1.json';
if (!(await store.head(marker))) {
  let checksums = {};
  if (await store.head('site-data/media-checksums.json'))
    checksums = JSON.parse(await (await store.get('site-data/media-checksums.json')).text());
  const manifest = await migrateLegacy(store, config, checksums);
  await request('media/import', { manifest, config });
  await store.putJSON(marker, { completedAt: new Date().toISOString(), assets: Object.keys(manifest.assets).length });
  console.log(`Migrated ${Object.keys(manifest.assets).length} media entries`);
} else console.log('Legacy media migration already complete');
