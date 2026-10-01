import { objectKeys } from '../../../shared/media-manifest.mjs';
import { jobsRequest } from './jobs.js';
export async function protectedMediaKeys(env) {
  const keys = new Set();
  if (!env.JOBS) return keys;
  const state = await jobsRequest(env, 'state');
  const protect = (manifest) =>
    Object.values(manifest.assets)
      .filter((asset) => asset.status !== 'deleted')
      .flatMap((asset) => objectKeys(asset.published))
      .forEach((key) => keys.add(key));
  protect(state.manifest);
  for (const job of state.jobs)
    if (['pending', 'running'].includes(job.status)) objectKeys(job.checkpoint).forEach((key) => keys.add(key));
  for (const deployment of [...state.deployments, ...state.builds.filter((build) => !build.finishedAt)]) {
    const object = await env.MEDIA.get(`site-data/media-manifests/${deployment.mediaRevision}.json`);
    if (!object) throw new Error('A referenced deployment snapshot is missing; media cleanup stopped');
    protect(JSON.parse(await object.text()));
  }
  return keys;
}
