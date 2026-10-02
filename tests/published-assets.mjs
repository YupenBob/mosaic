import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageAdmin, stampApp } from '../scripts/lib/published-assets.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mosaic-assets-'));
try {
  const source = path.join(root, 'source'),
    output = path.join(root, 'output');
  fs.mkdirSync(path.join(source, 'js'), { recursive: true });
  fs.mkdirSync(path.join(source, 'functions'));
  fs.writeFileSync(path.join(source, 'index.html'), '<script type="module" src="js/app.js?v=1"></script>');
  fs.writeFileSync(path.join(source, 'js/app.js'), "import { state } from './state.js?v=1';");
  fs.writeFileSync(path.join(source, 'js/state.js'), 'export const state = {};');
  fs.writeFileSync(path.join(source, 'functions/api.js'), "export { proxy } from './proxy.js';");
  const first = stageAdmin(source, output, root);
  assert.ok(fs.readFileSync(path.join(output, 'index.html'), 'utf8').includes('?v=' + first));
  assert.ok(fs.readFileSync(path.join(output, 'js/app.js'), 'utf8').includes('?v=' + first));
  assert.equal(
    fs.readFileSync(path.join(output, 'functions/api.js'), 'utf8'),
    fs.readFileSync(path.join(source, 'functions/api.js'), 'utf8'),
  );
  assert.equal(stageAdmin(source, output, root), first, 'identical source reuses cache keys');
  fs.appendFileSync(path.join(source, 'js/state.js'), '\n// changed');
  assert.notEqual(stageAdmin(source, output, root), first, 'dependency edits invalidate the whole graph');
  assert.throws(() => stageAdmin(source, root, root), /Unsafe/);
  fs.mkdirSync(path.join(output, 'assets/js'), { recursive: true });
  fs.writeFileSync(path.join(output, 'assets/js/app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(output, 'index.html'), '<script src="assets/js/app.js"></script>');
  const app = stampApp(output);
  assert.ok(fs.readFileSync(path.join(output, 'index.html'), 'utf8').includes(app));
  assert.equal(stampApp(output), app);
  console.log(
    'Published assets: stable content hashes, whole admin graph invalidation, proxy isolation and safe output passed',
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
