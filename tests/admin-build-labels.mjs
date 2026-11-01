/**
 * The admin build page maps GitHub's English step names to Chinese labels.
 * Stale labels (an older pipeline's steps) silently render English in the UI,
 * so this test derives the real step names from `.github/workflows/*.yml` and
 * checks the map in `cloud-admin/js/build.js`:
 *
 *   - every pipeline.yml step (the workflow the build page displays) is covered
 *   - pinned action references are normalized, so SHA/version bumps do not
 *     invalidate labels (no `@v4` keys)
 *   - no label key refers to a step that no longer exists in any workflow
 *   - every label is Chinese text
 *
 * Pure Node, no dependencies.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(root, '.github/workflows');
const buildSource = fs.readFileSync(path.join(root, 'cloud-admin/js/build.js'), 'utf8');

// ── Extract the label map and the normalizer from build.js ──
const mapBlock = /const STEP_LABELS_ZH = \{([\s\S]*?)\n\};/.exec(buildSource);
assert.ok(mapBlock, 'build.js must declare STEP_LABELS_ZH');
const labels = {};
for (const line of mapBlock[1].split('\n')) {
  if (!line.trim()) continue;
  const entry = /^\s*'([^']+)':\s*'([^']*)',?$/.exec(line);
  assert.ok(entry, `unparseable STEP_LABELS_ZH line: ${line.trim()}`);
  labels[entry[1]] = entry[2];
}
assert.ok(Object.keys(labels).length >= 15, 'label map is suspiciously small');

const normalizerSource = /function normalizeStepName\(name\) \{[\s\S]*?\n\}/.exec(buildSource);
assert.ok(normalizerSource, 'build.js must declare normalizeStepName');
const normalizeStepName = new Function(`return (${normalizerSource[0]})`)();
assert.match(buildSource, /STEP_LABELS_ZH\[normalizeStepName\(name\)\]/, 'stepLabel must normalize before lookup');

// ── Derive real step display names from the workflows ──
function parseSteps(text) {
  const lines = text.split('\n');
  const steps = [];
  for (let index = 0; index < lines.length; index++) {
    const start = /^ {6}- (.*)$/.exec(lines[index]);
    if (!start) continue;
    const stepLines = [start[1]];
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (line.length - line.trimStart().length <= 6) break;
      stepLines.push(line);
    }
    const block = stepLines.join('\n');
    const inline = (key) => {
      const match = new RegExp(`^${key}:\\s*(.*)$`).exec(start[1]);
      return match ? match[1].replace(/\s+#.*$/, '').trim() : null;
    };
    const named = (key) => {
      const match = new RegExp(`\\n\\s{8}${key}:\\s*(.+?)\\s*$`, 'm').exec(block);
      return match ? match[1].replace(/\s+#.*$/, '').trim() : null;
    };
    const unquote = (value) => (value ? value.replace(/^['"]|['"]$/g, '') : value);
    const name = unquote(inline('name') ?? named('name'));
    const uses = unquote(inline('uses') ?? named('uses'));
    let run = inline('run');
    if (run === null) run = named('run');
    if (run && /^[>|]/.test(run)) {
      // First body line of a block scalar.
      const body = block.split('\n').find((line) => /^\s{10,}\S/.test(line));
      run = body ? body.trim() : null;
    } else if (run) {
      run = run.split(' #')[0].trim();
    }
    steps.push({ name, uses, run });
  }
  return steps;
}

const workflowSteps = new Map();
for (const file of fs.readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
  workflowSteps.set(file, parseSteps(fs.readFileSync(path.join(workflowDir, file), 'utf8')));
}

/** Display names as GitHub renders them, including post steps for `uses`. */
function displayNames(steps) {
  const names = new Set();
  for (const step of steps) {
    if (step.name) names.add(step.name);
    else if (step.uses) names.add(`Run ${step.uses}`);
    else if (step.run) names.add(`Run ${step.run}`);
    if (step.uses) names.add(`Post Run ${step.uses}`);
  }
  return names;
}

const known = new Set();
for (const steps of workflowSteps.values()) for (const name of displayNames(steps)) known.add(normalizeStepName(name));

// Steps GitHub injects for every job; they never appear in the YAML itself.
const IMPLICIT_STEPS = new Set(['Set up job', 'Complete job']);

// 1. Every label key is a real, normalized step name somewhere in the workflows.
for (const key of Object.keys(labels)) {
  assert.ok(!key.includes('@'), `label key must not pin an action version: ${key}`);
  assert.ok(key === normalizeStepName(key), `label key must be a normalized step name: ${key}`);
  assert.ok(IMPLICIT_STEPS.has(key) || known.has(key), `label key does not match any workflow step: ${key}`);
}

// 2. Every step the admin build page can show (pipeline.yml) has a Chinese label.
const pipeline = workflowSteps.get('pipeline.yml');
assert.ok(pipeline?.length, 'pipeline.yml must contain steps');
for (const name of displayNames(pipeline)) {
  const key = normalizeStepName(name);
  assert.ok(labels[key], `pipeline step is missing a Chinese label: ${key}`);
  assert.match(labels[key], /[\u4e00-\u9fff]/, `label for ${key} must be Chinese text`);
}

// 3. No legacy pipeline vocabulary survives in the labels.
const legacy =
  /rclone|exif|checksums|sync media|upload to r2|strip media|copy functions|progress —|actions\/checkout@v|actions\/setup-node@v/i;
for (const key of Object.keys(labels)) assert.ok(!legacy.test(key), `stale label key: ${key}`);

console.log(
  `Admin build labels: ${Object.keys(labels).length} labels cover ${displayNames(pipeline).size} pipeline steps and no stale workflow steps`,
);
