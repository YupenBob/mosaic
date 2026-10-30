/**
 * Theme package contract. A theme is a directory under `themes/<id>/`:
 *
 *   theme.json          id/name/version/engine/layouts/options
 *   layouts/*.ejs       index, post, 404
 *   assets/             optional static assets copied to dist/theme/
 *
 * The built-in `default` theme keeps its layouts in `src/layouts`; theme.json
 * still describes its micro-options so the admin can render a form.
 */
export const THEME_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
export const DEFAULT_THEME = 'default';
export const THEME_LAYOUTS = ['index.ejs', 'post.ejs', '404.ejs'];
export const THEME_OPTION_TYPES = ['select', 'boolean', 'text', 'number', 'color'];

export function validateThemeManifest(manifest, id) {
  if (!manifest || typeof manifest !== 'object') throw new Error('theme.json must be an object');
  if (!THEME_ID_RE.test(String(manifest.id || id))) throw new Error('theme.id is invalid');
  if (String(manifest.id || id) !== id) throw new Error('theme.id must match its directory');
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('theme.name is required');
  if (manifest.engine !== undefined && manifest.engine !== 'ejs') throw new Error('only the ejs engine is supported');
  if (manifest.layouts !== undefined) {
    for (const layout of THEME_LAYOUTS) {
      if (manifest.layouts[layout] !== undefined && !/^[A-Za-z0-9._/-]+\.ejs$/.test(manifest.layouts[layout]))
        throw new Error(`theme.layouts.${layout} is invalid`);
    }
  }
  if (manifest.options !== undefined) {
    if (!manifest.options || typeof manifest.options !== 'object' || Array.isArray(manifest.options))
      throw new Error('theme.options must be an object');
    for (const [key, option] of Object.entries(manifest.options)) {
      if (!/^[a-z][a-zA-Z0-9]{0,40}$/.test(key)) throw new Error(`theme option key is invalid: ${key}`);
      if (!option || !THEME_OPTION_TYPES.includes(option.type))
        throw new Error(`theme option ${key} has an invalid type`);
      if (option.type === 'select' && (!Array.isArray(option.options) || !option.options.length))
        throw new Error(`theme option ${key} needs options`);
    }
  }
  return manifest;
}

export function themeOptionDefaults(manifest) {
  const defaults = {};
  for (const [key, option] of Object.entries(manifest?.options || {})) {
    if (option.default !== undefined) defaults[key] = option.default;
  }
  return defaults;
}

export function validateThemeOptions(manifest, values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new Error('theme options must be an object');
  const result = { ...themeOptionDefaults(manifest) };
  for (const [key, option] of Object.entries(manifest?.options || {})) {
    if (values[key] === undefined) continue;
    const value = values[key];
    if (option.type === 'boolean' && typeof value !== 'boolean') throw new Error(`theme option ${key} must be boolean`);
    if (option.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
      throw new Error(`theme option ${key} must be a number`);
    if (option.type === 'text' && typeof value !== 'string') throw new Error(`theme option ${key} must be text`);
    if (option.type === 'color' && !/^#[0-9a-fA-F]{6}$/.test(String(value)))
      throw new Error(`theme option ${key} must be a hex color`);
    if (option.type === 'select' && !option.options.some((item) => String(item.value ?? item) === String(value)))
      throw new Error(`theme option ${key} has an invalid value`);
    result[key] = value;
  }
  return result;
}
