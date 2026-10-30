/** Installed theme packages and applying micro-options to mosaic.config.json. */
import { DEFAULT_THEME, THEME_ID_RE, validateThemeManifest, validateThemeOptions } from '../../../shared/theme.mjs';
import { getConfig, updateConfig } from './site-config.js';
import { contentsUrl, decodeBase64, headers } from './github-client.js';
import { markDirty } from './publication.js';

async function fetchTheme(c, id) {
  const response = await fetch(contentsUrl(c, `themes/${id}/theme.json`), { headers: headers(c) });
  if (!response.ok) return null;
  const file = await response.json();
  const manifest = JSON.parse(decodeBase64(file.content));
  return validateThemeManifest(manifest, id);
}

export async function listThemes(c) {
  const response = await fetch(contentsUrl(c, 'themes'), { headers: headers(c) });
  const entries = response.ok ? await response.json() : [];
  const ids = new Set([DEFAULT_THEME]);
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry.type === 'dir' && THEME_ID_RE.test(entry.name)) ids.add(entry.name);
    }
  }
  const themes = [];
  for (const id of ids) {
    const manifest = await fetchTheme(c, id).catch(() => null);
    if (!manifest) continue;
    const config = await getConfig(c);
    themes.push({
      id,
      name: manifest.name,
      version: manifest.version || '',
      description: manifest.description || '',
      author: manifest.author || '',
      options: manifest.options || {},
      layouts: manifest.layouts || {},
      current: config.themePackage === id,
      values: config.themePackage === id ? config.themeOptions || {} : {},
    });
  }
  themes.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || a.name.localeCompare(b.name));
  const config = await getConfig(c);
  return { themes, current: { package: config.themePackage || DEFAULT_THEME, options: config.themeOptions || {} } };
}

export async function applyTheme(c, id, options = {}) {
  if (!THEME_ID_RE.test(id))
    throw Object.assign(new Error('Invalid theme id'), { status: 400, code: 'INVALID_PARAMS' });
  const manifest = await fetchTheme(c, id);
  if (!manifest) throw Object.assign(new Error('Theme not found'), { status: 404, code: 'NOT_FOUND' });
  const values = validateThemeOptions(manifest, options);
  const result = await updateConfig(c, { themePackage: id, themeOptions: values }, `Apply theme: ${id}`);
  await markDirty(c.env, '');
  return { ok: true, themePackage: id, themeOptions: values, commit: result.commit?.sha || '' };
}
