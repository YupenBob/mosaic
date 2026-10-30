import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_THEME,
  THEME_LAYOUTS,
  THEME_ID_RE,
  themeOptionDefaults,
  validateThemeManifest,
  validateThemeOptions,
} from '../../shared/theme.mjs';

/**
 * Resolve the active theme package. Default keeps the original src/layouts;
 * external themes own layouts/ and optionally assets/.
 */
export function resolveTheme(context) {
  const id = context.config.themePackage || DEFAULT_THEME;
  if (!THEME_ID_RE.test(id)) throw new Error('Invalid themePackage');
  const dir = path.join(context.root, 'themes', id);
  const manifestPath = path.join(dir, 'theme.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Theme not found: ${id}`);
  const manifest = validateThemeManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), id);
  const options = validateThemeOptions(manifest, context.config.themeOptions || {});
  const srcLayouts = path.join(context.src, 'layouts');
  const layoutPath = (name) =>
    manifest.layouts?.[name]
      ? path.join(dir, manifest.layouts[name])
      : path.join(id === DEFAULT_THEME ? srcLayouts : path.join(dir, 'layouts'), name);
  for (const layout of THEME_LAYOUTS) {
    if (!fs.existsSync(layoutPath(layout))) throw new Error(`Theme ${id} is missing ${layout}`);
  }
  const assetsDir = path.join(dir, 'assets');
  const config = structuredClone(context.config);
  if (id === DEFAULT_THEME) {
    // Micro-options for the built-in theme map onto the existing themeMode.
    if (options.accent !== undefined) config.themeMode.accent = options.accent;
    if (options.defaultMode !== undefined) config.themeMode.default = options.defaultMode;
    if (options.showThemeMenu !== undefined) config.themeMode.showMenu = options.showThemeMenu;
    if (options.allowVisitorToggle !== undefined) config.themeMode.allowVisitorToggle = options.allowVisitorToggle;
  }
  return {
    id,
    manifest,
    options: { ...themeOptionDefaults(manifest), ...options },
    config,
    layoutPath,
    assetsDir: fs.existsSync(assetsDir) ? assetsDir : null,
  };
}
