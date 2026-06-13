/**
 * Mosaic v0.8 — Theme Loader
 *
 * Loads a theme from themes/{name}/ directory and merges overrides
 * from mosaic.config.json's themeOverrides field.
 *
 * Theme structure:
 *   themes/{name}/
 *     theme.json      — metadata + token defaults
 *     tokens.css       — CSS custom properties (optional override)
 *     layouts/         — EJS template overrides (optional)
 *     css/             — additional stylesheets (optional)
 *     js/              — additional scripts (optional)
 */

import fs from 'fs-extra';
import path from 'path';
import { ROOT, SRC_DIR } from './utils.js';

/**
 * Load theme configuration.
 *
 * @param {string} themeName - Theme name from mosaic.config.json
 * @param {object} overrides - themeOverrides from mosaic.config.json
 * @returns {object} { tokens, templateDir, cssFiles, jsFiles }
 */
export async function loadTheme(themeName = 'default', overrides = {}) {
  const themeDir = path.join(ROOT, 'themes', themeName);

  // Fall back to default if theme doesn't exist
  const effectiveDir = (await fs.pathExists(themeDir))
    ? themeDir
    : path.join(ROOT, 'themes', 'default');

  // Load theme.json
  let themeMeta = { tokens: {} };
  try {
    themeMeta = await fs.readJSON(path.join(effectiveDir, 'theme.json'));
  } catch {
    // Use built-in defaults
  }

  // Merge token overrides
  const tokens = mergeTokens(themeMeta.tokens || {}, overrides);

  // Generate CSS variables from tokens
  const cssVars = tokensToCSSVars(tokens);

  // Determine template directory
  const themeLayouts = path.join(effectiveDir, 'layouts');
  const templateDir = (await fs.pathExists(themeLayouts))
    ? themeLayouts
    : path.join(SRC_DIR, 'layouts');  // Fall back to built-in layouts

  // Collect additional CSS/JS files
  const cssFiles = await collectThemeFiles(path.join(effectiveDir, 'css'));
  const jsFiles = await collectThemeFiles(path.join(effectiveDir, 'js'));

  return {
    name: themeName,
    themeDir: effectiveDir,
    tokens,
    cssVars,
    templateDir,
    cssFiles,
    jsFiles,
  };
}

/**
 * Deep merge token overrides.
 */
function mergeTokens(tokens, overrides) {
  const result = JSON.parse(JSON.stringify(tokens));

  if (overrides.colors) {
    result.colors = { ...result.colors, ...overrides.colors };
  }
  if (overrides.darkColors) {
    result.darkColors = { ...result.darkColors, ...overrides.darkColors };
  }
  if (overrides.fonts) {
    result.fonts = { ...result.fonts, ...overrides.fonts };
  }
  if (overrides.radii) {
    result.radii = { ...result.radii, ...overrides.radii };
  }
  if (overrides.layout) {
    result.layout = { ...result.layout, ...overrides.layout };
  }

  return result;
}

/**
 * Convert token object to CSS custom properties string.
 */
function tokensToCSSVars(tokens) {
  let css = '';

  // Light mode colors
  if (tokens.colors) {
    for (const [key, value] of Object.entries(tokens.colors)) {
      css += `  --color-${key}: ${value};\n`;
    }
  }

  // Fonts
  if (tokens.fonts) {
    for (const [key, value] of Object.entries(tokens.fonts)) {
      css += `  --font-${key}: ${value};\n`;
    }
  }

  // Radii
  if (tokens.radii) {
    for (const [key, value] of Object.entries(tokens.radii)) {
      css += `  --${key}-radius: ${value};\n`;
    }
  }

  // Layout
  if (tokens.layout) {
    for (const [key, value] of Object.entries(tokens.layout)) {
      css += `  --${key}: ${value};\n`;
    }
  }

  return css;
}

/**
 * Collect CSS or JS files from a theme subdirectory.
 */
async function collectThemeFiles(dir) {
  if (!(await fs.pathExists(dir))) return [];

  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (['.css', '.js'].includes(ext)) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  return files.sort();
}
