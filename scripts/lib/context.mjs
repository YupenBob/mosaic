import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, validateConfig } from '../../shared/config.mjs';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function loadContext(env = process.env) {
  const root = path.resolve(env.MOSAIC_ROOT || ROOT);
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'mosaic.config.json'), 'utf8'));
  const config = normalizeConfig(raw, env);
  const errors = validateConfig(config);
  if (errors.length) throw new Error(errors.join('\n'));
  return {
    root,
    config,
    content: path.join(root, 'content/posts'),
    src: path.join(root, 'src'),
    dist: path.resolve(env.MOSAIC_DIST || path.join(root, 'dist')),
    manifestPath: env.MEDIA_MANIFEST_FILE || path.join(root, '.mosaic/media-manifest.json'),
  };
}
