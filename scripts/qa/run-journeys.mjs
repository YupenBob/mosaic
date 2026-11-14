/**
 * UX journey runner.
 *
 * Usage:
 *   node scripts/qa/run-journeys.mjs --target local --area public
 *   node scripts/qa/run-journeys.mjs --target prod --area media --round 2
 *   node scripts/qa/run-journeys.mjs --target admin-prod --area admin
 *   node scripts/qa/run-journeys.mjs --file tests/ux/journeys/public-browse.spec.mjs --target local
 *
 * Targets: local | prod | admin-local | admin-prod
 * Results: qa/reports/round-<N>/<area>-<target>/results.json + per-journey JSON/PNGs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/context.mjs';
import { launchBrowser, openPage, blockWrites } from '../../tests/ux/lib/browser.mjs';
import { PROD, startLocalSite, startLocalAdmin } from '../../tests/ux/lib/targets.mjs';
import { createTestContext, writeJourneyResult } from '../../tests/ux/lib/journey.mjs';

const SPECS_DIR = path.join(ROOT, 'tests/ux/journeys');

function parseArgs(argv) {
  const options = { target: 'local', area: 'public', round: process.env.QA_ROUND || '0', file: '', journey: '' };
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.split('=');
    const value = inline ?? argv[index + 1];
    const take = () => (inline === undefined ? (index++, value) : value);
    if (flag === '--target') options.target = take();
    else if (flag === '--area') options.area = take();
    else if (flag === '--round') options.round = take();
    else if (flag === '--file') options.file = take();
    else if (flag === '--journey') options.journey = take();
    else if (flag === '--list') options.list = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function resolveTarget(target) {
  if (target === 'local') {
    const server = await startLocalSite();
    return { base: server.base, close: server.close, guardWrites: false };
  }
  if (target === 'prod') return { base: PROD.site, close: async () => {}, guardWrites: false, readOnly: false };
  if (target === 'admin-local') {
    const server = await startLocalAdmin();
    return { base: server.base, close: server.close, guardWrites: false, admin: true };
  }
  if (target === 'admin-prod') {
    if (!process.env.MOSAIC_ADMIN_PASSWORD) throw new Error('MOSAIC_ADMIN_PASSWORD is required for admin-prod');
    return { base: PROD.admin, close: async () => {}, guardWrites: true, admin: true, readOnly: true };
  }
  throw new Error(`unknown target: ${target}`);
}

async function collectSpecs(options) {
  const entries = [];
  if (options.file) {
    entries.push({ file: path.resolve(options.file), name: path.basename(options.file) });
  } else {
    if (!fs.existsSync(SPECS_DIR)) return entries;
    for (const name of fs
      .readdirSync(SPECS_DIR)
      .filter((entry) => entry.endsWith('.spec.mjs'))
      .sort()) {
      entries.push({ file: path.join(SPECS_DIR, name), name });
    }
  }
  const specs = [];
  for (const entry of entries) {
    const module = await import(entry.file);
    const area = module.area || path.basename(entry.name).split('-')[0];
    if (!options.file && area !== options.area) continue;
    for (const journey of module.journeys || [])
      specs.push({ ...journey, area, file: path.relative(ROOT, entry.file), targets: module.targets });
  }
  return specs;
}

function summarise(results, consoleResults) {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  const lines = results.map(
    (result) =>
      `${result.status === 'pass' ? 'PASS' : result.status === 'skip' ? 'SKIP' : 'FAIL'} ${result.id} (${result.durationMs}ms)${
        result.error ? `\n      ${result.error.split('\n')[0]}` : ''
      }`,
  );
  const consoleErrors = consoleResults.filter((entry) => entry.type === 'error').length;
  console.log(`\n${lines.join('\n')}\n`);
  console.log(`${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped; console errors: ${consoleErrors}`);
  return counts;
}

async function main() {
  const options = parseArgs(process.argv);
  const target = await resolveTarget(options.target);
  const specs = await collectSpecs(options);
  if (options.list) {
    for (const spec of specs) console.log(`${spec.priority} ${spec.id} ${spec.title}`);
    await target.close();
    return;
  }
  if (options.journey) {
    const filtered = specs.filter((spec) => spec.id === options.journey);
    specs.length = 0;
    specs.push(...filtered);
  }
  // A journey may pin itself to one target (e.g. production admin vs mocked admin).
  const targeted = specs.filter((spec) => !spec.targets || spec.targets.includes(options.target));
  if (targeted.length !== specs.length)
    console.log(`skipping ${specs.length - targeted.length} journey(s) pinned to another target`);
  specs.length = 0;
  specs.push(...targeted);
  if (specs.length === 0) throw new Error(`no journeys found for area "${options.area}" in ${SPECS_DIR}`);

  const runDir = path.join(ROOT, 'qa/reports', `round-${options.round}`, `${options.area}-${options.target}`);
  fs.mkdirSync(runDir, { recursive: true });
  console.log(
    `target=${options.target} base=${target.base} journeys=${specs.length} -> ${path.relative(ROOT, runDir)}`,
  );

  const browser = await launchBrowser();
  const results = [];
  const consoleResults = [];
  try {
    for (const spec of specs) {
      const started = Date.now();
      const { context, page, diagnostics } = await openPage(browser, { viewport: spec.viewport || 'desktop' });
      const writeAttempts = target.guardWrites ? await blockWrites(page) : [];
      const t = createTestContext({
        page,
        context,
        diagnostics,
        base: target.base,
        target: options.target,
        runDir,
        journey: spec,
        writeAttempts,
      });
      const result = {
        id: spec.id,
        title: spec.title,
        priority: spec.priority,
        area: spec.area,
        file: spec.file,
        status: 'pass',
        durationMs: 0,
        error: '',
        failures: [],
        notes: [],
        shots: [],
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
        writeAttempts: [],
      };
      try {
        await Promise.race([
          spec.steps(t),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`journey timeout after ${spec.timeoutMs}ms`)), spec.timeoutMs).unref?.(),
          ),
        ]);
        if (spec.assertNoErrors !== false) {
          if (diagnostics.pageErrors.length) throw new Error(`page errors: ${diagnostics.pageErrors.join(' | ')}`);
        }
        await t.shot('final');
      } catch (error) {
        result.status = 'fail';
        result.error = String(error?.stack || error);
        result.failures = t.failures;
        await t.shot('failure').catch(() => {});
      } finally {
        result.durationMs = Date.now() - started;
        result.notes = t.notes;
        result.shots = t.shots;
        result.consoleErrors = diagnostics.consoleErrors.slice(0, 20);
        result.pageErrors = diagnostics.pageErrors.slice(0, 20);
        result.failedRequests = diagnostics.failedRequests.slice(0, 20);
        result.writeAttempts = t.writeAttempts;
        consoleResults.push(...t.consoleAll);
        writeJourneyResult(runDir, result);
        results.push(result);
        await context.close().catch(() => {});
        console.log(
          `${result.status.toUpperCase()} ${result.id} ${result.durationMs}ms${result.error ? ` — ${result.error.split('\n')[0]}` : ''}`,
        );
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await target.close();
  }

  const counts = summarise(results, consoleResults);
  fs.writeFileSync(
    path.join(runDir, 'results.json'),
    JSON.stringify(
      {
        target: options.target,
        area: options.area,
        round: options.round,
        startedAt: new Date().toISOString(),
        counts,
        journeys: results,
        consoleErrors: consoleResults.filter((entry) => entry.type === 'error').slice(0, 200),
      },
      null,
      2,
    ),
  );
  process.exitCode = counts.fail > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(2);
});
