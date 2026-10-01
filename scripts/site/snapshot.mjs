import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadContext } from '../lib/context.mjs';
import { createPipelineClient } from '../lib/pipeline-client.mjs';
const context = loadContext();
const directory = path.join(context.root, '.mosaic');
const leaseFile = path.join(directory, 'build-lease.json');
const [operation, value] = process.argv.slice(2);
const request = createPipelineClient();
if (operation === 'begin') {
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: context.root, encoding: 'utf8' }).trim();
  const result = await request('site/begin', { runId: process.env.GITHUB_RUN_ID, gitSha });
  const { manifest, ...lease } = result;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(context.manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(leaseFile, JSON.stringify(lease));
  console.log(`Site snapshot: ${lease.gitSha}, media revision ${lease.mediaRevision}`);
} else {
  const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
  await request(operation === 'done' ? 'site/done' : 'site/progress', {
    ...lease,
    ...(operation === 'done'
      ? { success: value === 'success', cachePublished: process.env.CACHE_STATUS === 'success' }
      : { stage: value || operation }),
  });
}
