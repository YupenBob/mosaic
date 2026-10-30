/**
 * Theme package listing and apply, with GitHub contents mocked from the repo.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRuntime } from './helpers/runtime.mjs';
import { applyTheme, listThemes } from '../worker/src/services/themes.js';

const runtime = createRuntime();
const context = { env: runtime.env };
const baseConfig = JSON.parse(fs.readFileSync('mosaic.config.json', 'utf8'));
const realFetch = globalThis.fetch;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/contents/themes') && (!init.method || init.method === 'GET')) {
    return json([
      { type: 'dir', name: 'default' },
      { type: 'dir', name: 'starter' },
    ]);
  }
  const theme = /\/contents\/themes\/([a-z-]+)\/theme\.json$/.exec(path);
  if (theme) {
    const file = `themes/${theme[1]}/theme.json`;
    if (!fs.existsSync(file)) return json({ message: 'Not found' }, 404);
    return json({ content: Buffer.from(fs.readFileSync(file, 'utf8')).toString('base64') });
  }
  if (path.endsWith('/contents/mosaic.config.json')) {
    if (init.method === 'PUT') return json({ commit: { sha: 'theme-commit' } });
    return json({ content: Buffer.from(JSON.stringify(baseConfig)).toString('base64') });
  }
  return json({ message: 'Not found' }, 404);
};

try {
  const listed = await listThemes(context);
  assert.deepEqual(
    listed.themes.map((theme) => theme.id),
    ['default', 'starter'],
  );
  assert.equal(listed.themes[0].current, true);
  assert.equal(listed.themes[0].options.accent.type, 'select');
  assert.equal(listed.themes[0].options.accent.label, '强调色', 'UTF-8 theme labels survive base64 decoding');
  const applied = await applyTheme(context, 'starter', { accent: '#112233', showDescription: false });
  assert.equal(applied.themePackage, 'starter');
  assert.equal(applied.themeOptions.accent, '#112233');
  await assert.rejects(() => applyTheme(context, 'starter', { accent: 'not-a-color' }), /hex color/);
  await assert.rejects(() => applyTheme(context, 'missing', {}), /Theme not found/);
  console.log('Themes API: list, apply and validation passed');
} finally {
  globalThis.fetch = realFetch;
}
