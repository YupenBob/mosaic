/** Preview content preparation: draft JSON → content/posts/<slug>/index.md. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-preview-'));
const draftFile = path.join(root, 'draft.json');
fs.writeFileSync(
  draftFile,
  JSON.stringify({
    draft: {
      slug: 'preview-post',
      body: 'Preview body',
      frontMatter: { title: 'Preview title', date: '2026-10-30' },
      media: { gallery: ['ast_00000000000000000000000000'], videos: [], music: [], cover: null },
    },
  }),
);
execFileSync('node', [path.join(process.cwd(), 'scripts/preview/write-draft.mjs'), draftFile], {
  cwd: root,
  stdio: 'pipe',
});
const written = fs.readFileSync(path.join(root, 'content/posts/preview-post/index.md'), 'utf8');
assert.match(written, /title: Preview title/);
assert.match(written, /Preview body/);
assert.match(written, /ast_00000000000000000000000000/);

fs.writeFileSync(draftFile, JSON.stringify({ draft: { slug: '../escape', body: '' } }));
assert.throws(
  () =>
    execFileSync('node', [path.join(process.cwd(), 'scripts/preview/write-draft.mjs'), draftFile], {
      cwd: root,
      stdio: 'pipe',
    }),
  /Unsafe preview slug/,
);
fs.rmSync(root, { recursive: true, force: true });
console.log('Preview workflow: draft write and unsafe slug rejection passed');
