/**
 * Theme package contract + build-time resolution. No browser needed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveTheme } from '../scripts/site/theme.mjs';
import { validateThemeManifest, validateThemeOptions, themeOptionDefaults } from '../shared/theme.mjs';

const root = process.cwd();
const defaultManifest = validateThemeManifest(
  JSON.parse(fs.readFileSync(`${root}/themes/default/theme.json`, 'utf8')),
  'default',
);
const starterManifest = validateThemeManifest(
  JSON.parse(fs.readFileSync(`${root}/themes/starter/theme.json`, 'utf8')),
  'starter',
);
assert.equal(defaultManifest.id, 'default');
assert.equal(starterManifest.id, 'starter');
assert.equal(themeOptionDefaults(defaultManifest).accent, 'blue');
assert.equal(validateThemeOptions(defaultManifest, { accent: 'rose' }).accent, 'rose');
assert.throws(() => validateThemeOptions(defaultManifest, { accent: 'magenta' }), /invalid value/);
assert.throws(() => validateThemeManifest({ ...starterManifest, id: 'other' }, 'starter'), /must match/);

const baseConfig = { themePackage: 'default', themeOptions: {}, themeMode: { accent: 'blue', default: 'auto' } };
const defaultTheme = resolveTheme({ root, src: `${root}/src`, config: baseConfig });
assert.equal(defaultTheme.id, 'default');
assert.equal(defaultTheme.layoutPath('index.ejs'), `${root}/src/layouts/index.ejs`);
assert.equal(defaultTheme.options.accent, 'blue');

const overridden = resolveTheme({
  root,
  src: `${root}/src`,
  config: { ...baseConfig, themeOptions: { accent: 'rose', defaultMode: 'dark' } },
});
assert.equal(overridden.config.themeMode.accent, 'rose');
assert.equal(overridden.config.themeMode.default, 'dark');

const starter = resolveTheme({ root, src: `${root}/src`, config: { ...baseConfig, themePackage: 'starter' } });
assert.equal(starter.id, 'starter');
assert.ok(starter.layoutPath('index.ejs').endsWith('/themes/starter/layouts/index.ejs'));
assert.ok(starter.assetsDir.endsWith('/themes/starter/assets'));
assert.throws(() => resolveTheme({ root, src: `${root}/src`, config: { themePackage: 'missing' } }), /Theme not found/);

console.log('Theme smoke: manifest, options, default/starter resolution passed');
