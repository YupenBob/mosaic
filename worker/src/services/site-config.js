import { DEFAULTS, deepMerge, normalizeConfig, validateConfig } from '../../../shared/config.mjs';
import {
  contentsUrl,
  branchPayload,
  headers,
  decodeBase64,
  encodeBase64,
  cacheFor,
  bustCache,
} from './github-client.js';
// ====== Config ======

export async function getConfig(c) {
  const cache = cacheFor(c.env);
  if (cache.config && Date.now() - cache.configTime < (cache.config.cache.configMs ?? DEFAULTS.cache.configMs))
    return cache.config;
  const resp = await fetch(contentsUrl(c, `mosaic.config.json`), {
    headers: headers(c),
  });
  if (!resp.ok) return normalizeConfig({}, c.env);
  const file = await resp.json();
  const fresh = normalizeConfig(JSON.parse(decodeBase64(file.content)), c.env);
  cache.config = fresh;
  cache.configTime = Date.now();
  return fresh;
}

export async function updateConfig(c, config, message) {
  const existing = await fetch(contentsUrl(c, `mosaic.config.json`), {
    headers: headers(c),
  });
  if (!existing.ok) throw new Error('Config not found');
  const file = await existing.json();
  const current = JSON.parse(decodeBase64(file.content));
  // Deep merge: the admin form only sends edited fields; never drop nested sections
  const merged = deepMerge(current, config);
  if (config.enableVideoCompression !== undefined && config.plugins?.['compress-videos']?.enabled === undefined)
    merged.plugins = deepMerge(merged.plugins || {}, {
      'compress-videos': { enabled: config.enableVideoCompression !== false },
    });
  const errors = validateConfig(normalizeConfig(merged, c.env));
  if (errors.length) throw new Error(errors.join('; '));
  const resp = await fetch(contentsUrl(c, `mosaic.config.json`), {
    method: 'PUT',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...branchPayload(c),
      message: message || 'Update config',
      content: encodeBase64(JSON.stringify(merged, null, 2)),
      sha: file.sha,
    }),
  });
  if (!resp.ok) throw new Error(`updateConfig: ${resp.status}`);
  bustCache();
  return resp.json();
}
