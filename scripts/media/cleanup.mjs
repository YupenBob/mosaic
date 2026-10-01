import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../lib/context.mjs';
import { createPipelineClient } from '../lib/pipeline-client.mjs';
import { createStorage } from './storage.mjs';
import { objectKeys } from '../../shared/media-manifest.mjs';
export async function cleanupMedia({ config, state, store, now = Date.now() }) {
  const protectedKeys = new Set();
  const protect = (manifest) =>
    Object.values(manifest.assets)
      .filter((asset) => asset.status !== 'deleted')
      .flatMap((asset) => objectKeys(asset.published))
      .forEach((key) => protectedKeys.add(key));
  protect(state.manifest);
  for (const job of state.jobs)
    if (['pending', 'running'].includes(job.status))
      objectKeys(job.checkpoint).forEach((key) => protectedKeys.add(key));
  // Retained deployments and in-flight builds hold references to immutable snapshots.
  for (const deployment of [...state.deployments, ...(state.builds || []).filter((build) => !build.finishedAt)]) {
    const key = `site-data/media-manifests/${deployment.mediaRevision}.json`;
    if (!(await store.head(key))) throw new Error(`Referenced media snapshot is missing: ${key}`);
    protect(JSON.parse(await (await store.get(key)).text()));
  }
  const threshold = now - config.media.retentionDays * 86400000,
    remove = [];
  for await (const object of store.list('processed/'))
    if (!protectedKeys.has(object.key) && object.uploaded?.getTime() < threshold) remove.push(object.key);
  await store.delete(remove);
  return remove;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.GITHUB_RUN_ID) throw new Error('Media cleanup must run in GitHub Actions');
  const { config } = loadContext(),
    request = createPipelineClient(),
    store = createStorage(config);
  const remove = await cleanupMedia({ config, state: await request('media/state'), store });
  console.log(`Removed ${remove.length} unreferenced media objects`);
}
