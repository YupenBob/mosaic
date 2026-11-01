/**
 * Workflow policy check: pinned actions, least-privilege secrets, timeouts,
 * cache paths, deduplicated triggers and the deployment-environment guarantees.
 *
 * CI runs it via `npm run check`; run `node scripts/check-workflows.mjs` locally
 * after editing anything under `.github/workflows/`. The parser is intentionally
 * small: it understands the block style used by this repository (2-space job
 * indent, 6-space step indent) so it can enforce rules without a YAML dependency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDirectory = path.join(root, '.github/workflows');
const errors = [];
const warnings = [];

/** Trigger and deployment expectation for every workflow this repository owns. */
const SPEC = {
  'verify.yml': {
    name: 'Verify Mosaic',
    triggers: ['pull_request', 'push'],
    forbid: ['schedule', 'workflow_dispatch'],
    cancelInProgress: true,
    pushBranchesIgnore: ['main'],
    pushBranches: null,
  },
  'pipeline.yml': {
    name: 'Mosaic Site',
    triggers: ['push', 'workflow_dispatch'],
    forbid: ['pull_request', 'schedule'],
    cancelInProgress: false,
    pushBranches: ['main'],
    environment: 'production',
  },
  'infrastructure.yml': {
    name: 'Mosaic Infrastructure',
    triggers: ['push', 'workflow_dispatch'],
    forbid: ['pull_request', 'schedule'],
    cancelInProgress: false,
    pushBranches: ['main'],
    environment: 'production',
  },
  'media.yml': {
    name: 'Mosaic Media',
    triggers: ['workflow_dispatch'],
    forbid: ['push', 'pull_request', 'schedule'],
    cancelInProgress: false,
  },
  'preview.yml': {
    name: 'Mosaic Preview',
    triggers: ['workflow_dispatch'],
    forbid: ['push', 'pull_request', 'schedule'],
    cancelInProgress: true,
  },
  'migrate-v2.yml': {
    name: 'Mosaic Media v2 Migration',
    triggers: ['push', 'workflow_dispatch'],
    forbid: ['pull_request', 'schedule'],
    cancelInProgress: false,
    environment: 'production',
  },
  'probe.yml': {
    name: 'Mosaic Probe',
    triggers: ['schedule', 'workflow_dispatch'],
    forbid: ['push', 'pull_request'],
    cancelInProgress: true,
    cron: '0 */3 * * *',
    maxTimeoutMinutes: 5,
  },
  'health-check.yml': {
    name: 'Production Health Check',
    triggers: ['schedule', 'workflow_dispatch'],
    forbid: ['push', 'pull_request'],
    cancelInProgress: true,
    cron: '0 2 * * *',
  },
  'maintenance.yml': {
    name: 'Mosaic Maintenance',
    triggers: ['schedule', 'workflow_dispatch'],
    forbid: ['push', 'pull_request'],
    cancelInProgress: false,
    cron: '0 3 * * 1',
  },
  'rollback.yml': {
    name: 'Mosaic Rollback',
    triggers: ['workflow_dispatch'],
    forbid: ['push', 'pull_request', 'schedule'],
    cancelInProgress: false,
    environment: 'production',
  },
};

const SHA_PINNED = /^[0-9a-f]{40}$/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line) {
  const trimmed = line.trim();
  return !trimmed || trimmed.startsWith('#');
}

/** Lines of the block that starts at `start` (exclusive) until a line with less indentation. */
function blockAfter(lines, start, blockIndent) {
  const result = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (isBlankOrComment(line)) {
      result.push(line);
      continue;
    }
    if (indentOf(line) <= blockIndent) break;
    result.push(line);
  }
  return result;
}

/** Collect `- value` entries from a block (e.g. push.branches). */
function listValues(block) {
  const values = [];
  for (const line of block) {
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (match) values.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return values;
}

/** Simple key/value pairs of a mapped block (`branches: [main]` and `- item` lists). */
function readMapping(block) {
  const mapping = new Map();
  for (let index = 0; index < block.length; index++) {
    const line = block[index];
    if (isBlankOrComment(line)) continue;
    const match = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, spaces, key, rest] = match;
    const inline = rest.replace(/\s+#.*$/, '').trim();
    if (inline.startsWith('[')) {
      mapping.set(
        key,
        listValues(
          inline
            .slice(1, -1)
            .split(',')
            .map((item) => `- ${item.trim()}`),
        ),
      );
    } else if (inline) {
      mapping.set(key, inline.replace(/^['"]|['"]$/g, ''));
    } else {
      mapping.set(key, listValues(blockAfter(block, index, spaces.length)));
    }
  }
  return mapping;
}

function parseWorkflow(file, text) {
  const lines = text.split('\n');
  const workflow = {
    file,
    text,
    lines,
    topLevelKeys: new Set(),
    triggers: new Set(),
    push: new Map(),
    pullRequest: new Map(),
    crons: [],
    permissions: false,
    concurrency: null,
    jobs: [],
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (isBlankOrComment(line) || indentOf(line) !== 0) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    workflow.topLevelKeys.add(key);
    if (key === 'permissions') workflow.permissions = true;
    if (key === 'on') {
      const block = blockAfter(lines, index, 0);
      for (let offset = 0; offset < block.length; offset++) {
        const triggerMatch = /^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/.exec(block[offset]);
        if (!triggerMatch) continue;
        workflow.triggers.add(triggerMatch[1]);
        const triggerBlock = blockAfter(block, offset, 2);
        if (triggerMatch[1] === 'push') workflow.push = readMapping(triggerBlock);
        if (triggerMatch[1] === 'pull_request') workflow.pullRequest = readMapping(triggerBlock);
        if (triggerMatch[1] === 'schedule') {
          for (const entry of triggerBlock) {
            const cron = /cron:\s*['"]?([^'"]+)['"]?/.exec(entry);
            if (cron) workflow.crons.push(cron[1].trim());
          }
        }
      }
      index += block.length;
    }
    if (key === 'concurrency') {
      const block = blockAfter(lines, index, 0);
      workflow.concurrency = readMapping(block);
      index += block.length;
    }
    if (key === 'jobs') {
      const block = blockAfter(lines, index, 0);
      for (let offset = 0; offset < block.length; offset++) {
        const jobMatch = /^\s{2}([A-Za-z0-9_-]+):\s*$/.exec(block[offset]);
        if (!jobMatch) continue;
        const jobBlock = blockAfter(block, offset, 2);
        const job = { name: jobMatch[1], timeoutMinutes: null, steps: [], lines: jobBlock, text: jobBlock.join('\n') };
        for (let lineIndex = 0; lineIndex < jobBlock.length; lineIndex++) {
          const line = jobBlock[lineIndex];
          if (isBlankOrComment(line)) continue;
          const timeout = /^\s{4}timeout-minutes:\s*(.+?)\s*$/.exec(line);
          if (timeout) job.timeoutMinutes = timeout[1].replace(/\s+#.*$/, '');
          const stepMatch = /^\s{6}-\s+(.*)$/.exec(line);
          if (stepMatch || /^\s{6}-$/.test(line)) {
            const stepLines = [line];
            for (let next = lineIndex + 1; next < jobBlock.length; next++) {
              const candidate = jobBlock[next];
              if (!isBlankOrComment(candidate) && indentOf(candidate) <= 6) break;
              stepLines.push(candidate);
            }
            job.steps.push(parseStep(stepLines));
          }
        }
        workflow.jobs.push(job);
        offset += jobBlock.length;
      }
    }
  }
  return workflow;
}

function parseStep(stepLines) {
  const joined = stepLines.join('\n');
  const first = stepLines[0].replace(/^\s{6}-\s?/, '').trim();
  const step = { uses: null, name: null, run: '', env: '', with: '', text: joined };
  const uses = /(?:^|\n)\s{8}uses:\s*(\S+)/.exec(joined);
  if (uses) step.uses = uses[1].trim();
  const name = /(?:^|\n)\s{8}name:\s*(.+?)\s*$/.exec(joined);
  if (name) step.name = name[1];
  if (/^uses:/.test(first) && !step.uses) step.uses = first.replace(/^uses:\s*/, '').trim();
  if (/^name:/.test(first) && !step.name) step.name = first.replace(/^name:\s*/, '').trim();
  // run/env/with blocks: indentation above the step key level.
  const sections = { run: '', env: '', with: '' };
  let current = null;
  for (const line of stepLines.slice(1)) {
    if (isBlankOrComment(line)) {
      if (current) sections[current] += `${line}\n`;
      continue;
    }
    const section = /^\s{8}(run|env|with):\s*(.*)$/.exec(line);
    if (section) {
      current = section[1];
      sections[current] += `${section[2]}\n`;
      continue;
    }
    if (indentOf(line) < 8) {
      current = null;
      continue;
    }
    if (current) sections[current] += `${line}\n`;
  }
  step.run = sections.run;
  step.env = sections.env;
  step.with = sections.with;
  return step;
}

function fail(file, message) {
  errors.push(`${file}: ${message}`);
}

function checkWorkflow(workflow, spec) {
  const { file, text } = workflow;
  if (!workflow.topLevelKeys.has('name')) fail(file, 'missing top-level name');
  if (!workflow.topLevelKeys.has('on')) fail(file, 'missing top-level on');
  if (!workflow.permissions) fail(file, 'missing top-level permissions (least privilege is mandatory)');
  if (!workflow.topLevelKeys.has('concurrency')) fail(file, 'missing top-level concurrency group');
  if (!workflow.jobs.length) fail(file, 'no jobs defined');
  if (!workflow.triggers.size) fail(file, 'no triggers defined');

  // ── Trigger deduplication / scheduling ──
  if (spec) {
    for (const trigger of spec.triggers) {
      if (!workflow.triggers.has(trigger)) fail(file, `missing expected trigger "${trigger}"`);
    }
    for (const trigger of spec.forbid || []) {
      if (workflow.triggers.has(trigger)) fail(file, `trigger "${trigger}" must stay disabled here`);
    }
    if (spec.pushBranches) {
      const branches = workflow.push.get('branches') || [];
      if (!branches.includes('main') || branches.length !== 1)
        fail(file, `push branches must be exactly [main], found [${branches.join(', ')}]`);
    }
    if (spec.pushBranchesIgnore) {
      const branchesIgnore = workflow.push.get('branches-ignore') || [];
      if (!branchesIgnore.includes('main'))
        fail(file, `push branches-ignore must include main, found [${branchesIgnore.join(', ')}]`);
      const branches = workflow.push.get('branches') || [];
      if (branches.includes('main')) fail(file, 'push must not target main here');
    }
    if (spec.cron && !workflow.crons.includes(spec.cron)) fail(file, `schedule must use cron "${spec.cron}"`);
    if (spec.name && !text.startsWith(`name: ${spec.name}`))
      fail(file, `workflow name must be "${spec.name}" for admin/build attribution`);
    if (workflow.concurrency) {
      const cancel = workflow.concurrency.get('cancel-in-progress');
      if (cancel === undefined) fail(file, 'concurrency must set cancel-in-progress explicitly');
      else if (spec.cancelInProgress !== undefined && String(cancel) !== String(spec.cancelInProgress))
        fail(file, `cancel-in-progress must be ${spec.cancelInProgress}, found ${cancel}`);
    }
    if (spec.environment && !new RegExp(`^\\s+environment:\\s*${spec.environment}\\s*$`, 'm').test(text))
      fail(file, `deployment job must declare "environment: ${spec.environment}"`);
    if (spec.maxTimeoutMinutes) {
      for (const job of workflow.jobs) {
        const minutes = Number(job.timeoutMinutes);
        if (Number.isFinite(minutes) && minutes > spec.maxTimeoutMinutes)
          fail(file, `job ${job.name} timeout ${minutes} exceeds ${spec.maxTimeoutMinutes} minutes`);
      }
    }
  }

  // ── Secrets must live on the step that calls the external API ──
  for (const [index, line] of workflow.lines.entries()) {
    if (!line.includes('secrets.')) continue;
    if (isBlankOrComment(line)) continue;
    const mapping = /^\s+([A-Z][A-Z0-9_]*):\s*\$\{\{\s*secrets\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}\s*$/.exec(line);
    if (!mapping) {
      fail(file, `line ${index + 1}: secrets must be a step env map value (KEY: \${{ secrets.X }})`);
      continue;
    }
    if (indentOf(line) < 10)
      fail(file, `line ${index + 1}: secret ${mapping[1]} is job/top-level env; scope it to the external-call step`);
  }

  // ── Pinned actions and pinned-version documentation ──
  for (const line of workflow.lines) {
    if (isBlankOrComment(line)) continue;
    if (/cloudflare\/wrangler-action/.test(line))
      fail(file, 'cloudflare/wrangler-action is banned; use npm exec --prefix worker -- wrangler');
    const uses = /^\s*(?:-\s+)?uses:\s*(\S+)\s*(#.*)?$/.exec(line);
    if (!uses) continue;
    const ref = uses[1];
    if (ref.startsWith('./')) continue;
    const at = ref.lastIndexOf('@');
    if (at === -1) {
      fail(file, `action ${ref} has no ref; pin a 40-character commit SHA`);
      continue;
    }
    const sha = ref.slice(at + 1);
    if (!SHA_PINNED.test(sha)) fail(file, `action ${ref} is not pinned to a 40-character SHA`);
    if (!uses[2] || !/#\s*v\d/.test(uses[2]))
      fail(file, `action ${ref} must record its version ("# vN") after the SHA`);
  }

  // ── Jobs: timeouts, setup-node caches, worker dependency installs ──
  const workflowRuns = workflow.jobs.map((job) => job.steps.map((step) => step.run).join('\n')).join('\n');
  for (const job of workflow.jobs) {
    if (!job.timeoutMinutes) fail(file, `job ${job.name} has no timeout-minutes`);
    if (!/^\s{4}runs-on:/m.test(job.text)) fail(file, `job ${job.name} has no runs-on`);
    for (const step of job.steps) {
      if (step.uses && step.uses.startsWith('actions/setup-node@')) {
        if (!/cache:\s*npm/.test(step.with)) fail(file, `job ${job.name}: setup-node must cache npm`);
        if (!/cache-dependency-path:/.test(step.with) || !/worker\/package-lock\.json/.test(step.with))
          fail(file, `job ${job.name}: setup-node cache-dependency-path must include worker/package-lock.json`);
      }
    }
  }
  if (/npm run check/.test(workflowRuns) && !/npm ci --prefix worker/.test(workflowRuns))
    fail(file, 'workflows that run "npm run check" must install worker dependencies (npm ci --prefix worker)');
}

// ── Run ──
const workflowFiles = fs
  .readdirSync(workflowDirectory)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort();

for (const file of workflowFiles) {
  const text = fs.readFileSync(path.join(workflowDirectory, file), 'utf8');
  const workflow = parseWorkflow(file, text);
  const spec = SPEC[file];
  if (!spec) warnings.push(`${file}: no trigger spec in scripts/check-workflows.mjs (generic rules only)`);
  checkWorkflow(workflow, spec);
}

for (const file of Object.keys(SPEC))
  if (!workflowFiles.includes(file)) fail(file, 'workflow is listed in the policy spec but missing');

// Dependabot must cover actions, the generator and the Worker runtime.
const dependabotPath = path.join(root, '.github/dependabot.yml');
if (!fs.existsSync(dependabotPath)) {
  fail('.github/dependabot.yml', 'missing');
} else {
  const dependabot = fs.readFileSync(dependabotPath, 'utf8');
  for (const [label, pattern] of [
    ['github-actions ecosystem', /package-ecosystem:\s*github-actions/],
    ['root npm ecosystem', /package-ecosystem:\s*npm\s*\n\s*directory:\s*['"]?\/['"]?\s*\n/],
    ['worker npm ecosystem', /package-ecosystem:\s*npm\s*\n\s*directory:\s*['"]?\/worker['"]?\s*\n/],
    ['weekly schedule', /interval:\s*weekly/],
  ])
    if (!pattern.test(dependabot)) fail('.github/dependabot.yml', `missing ${label}`);
}

if (warnings.length) for (const warning of warnings) console.warn(`warning: ${warning}`);
if (errors.length) {
  console.error(`\n${errors.length} workflow problem(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(
  `Workflows OK (${workflowFiles.length} files): pinned SHAs, scoped secrets, timeouts, caches, deduplicated triggers`,
);
