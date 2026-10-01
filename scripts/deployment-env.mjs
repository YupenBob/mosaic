import fs from 'node:fs';
import path from 'node:path';
import { loadContext } from './lib/context.mjs';
const { config } = loadContext();
const values = {
  SITE_BRANCH: config.deployment.branch,
  SITE_PROJECT: config.deployment.siteProject,
  ADMIN_PROJECT: config.deployment.adminProject,
  R2_BUCKET: config.mediaSource.bucket,
  API_TARGET: process.env.API_TARGET || config.apiBase.replace(/\/api\/?$/, ''),
};
if (!process.env.GITHUB_ENV) throw new Error('GITHUB_ENV is required');
for (const [key, value] of Object.entries(values)) {
  if (/[\r\n]/.test(value)) throw new Error(`Invalid deployment setting ${key}`);
  fs.appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
}
if (process.argv.includes('--worker-config')) {
  const { root } = loadContext();
  fs.mkdirSync(path.join(root, '.mosaic'), { recursive: true });
  const origins = process.env.ALLOWED_ORIGINS || config.deployment.allowedOrigins.join(',');
  fs.writeFileSync(
    path.join(root, '.mosaic/worker.json'),
    JSON.stringify(
      {
        name: config.deployment.workerName,
        main: path.join(root, 'worker/src/index.js'),
        compatibility_date: '2024-04-01',
        r2_buckets: [{ binding: 'MEDIA', bucket_name: config.mediaSource.bucket }],
        durable_objects: {
          bindings: [
            { name: 'STATS', class_name: 'StatsDurableObject' },
            { name: 'JOBS', class_name: 'JobsDurableObject' },
          ],
        },
        migrations: [
          { tag: 'v1', new_sqlite_classes: ['StatsDurableObject'] },
          { tag: 'v2-media-jobs', new_sqlite_classes: ['JobsDurableObject'] },
        ],
        vars: {
          GITHUB_REPO: process.env.GITHUB_REPOSITORY,
          R2_BUCKET: config.mediaSource.bucket,
          SITE_BRANCH: config.deployment.branch,
          MEDIA_MANIFEST_KEY: config.media.manifestKey,
          REQUIRE_MEDIA_MIGRATION: 'true',
          ALLOWED_ORIGINS: origins,
        },
        observability: { enabled: true, head_sampling_rate: 1 },
      },
      null,
      2,
    ),
  );
}
