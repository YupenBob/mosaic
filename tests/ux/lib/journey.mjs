/**
 * Journey definition helpers.
 *
 * A journey spec exports:
 *   export const area = 'public';
 *   export const journeys = [defineJourney({ id, title, priority, steps: async (t) => {...} })];
 *
 * The runner owns the browser, screenshots, diagnostics and reporting; a
 * journey only drives the page and fails through t.assert / thrown errors.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

export function defineJourney(spec) {
  if (!spec.id || !spec.title || typeof spec.steps !== 'function')
    throw new Error('defineJourney requires id, title and steps');
  return {
    priority: 'P2',
    tags: [],
    timeoutMs: Number(process.env.QA_JOURNEY_TIMEOUT_MS || 120000),
    ...spec,
  };
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected)
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function assertMatch(value, pattern, message) {
  if (!pattern.test(String(value))) throw new Error(`${message}: ${JSON.stringify(value)} did not match ${pattern}`);
}

/** Poll `check` (sync or async) until truthy or the deadline passes. */
export async function waitFor(check, { timeout = 8000, interval = 100, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`timed out waiting for ${message}${lastError ? ` (${lastError.message})` : ''}`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Create the per-journey test context handed to `steps(t)`. */
export function createTestContext({ page, context, diagnostics, base, target, runDir, journey, writeAttempts = [] }) {
  const failures = [];
  const notes = [];
  const shots = [];
  const consoleAll = [];
  page.on('console', (message) => consoleAll.push({ type: message.type(), text: message.text() }));

  const t = {
    page,
    context,
    diagnostics,
    base,
    target,
    failures,
    notes,
    shots,
    consoleAll,
    writeAttempts,
    async goto(route = '/', options = {}) {
      const url = route.startsWith('http') ? route : `${base}${route.startsWith('/') ? '' : '/'}${route}`;
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, ...options });
      return response;
    },
    assert(condition, message) {
      if (!condition) {
        failures.push(message);
        throw new Error(message);
      }
    },
    assertEqual(actual, expected, message) {
      t.assert(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    note(message) {
      notes.push(message);
    },
    async shot(name) {
      if (!page.isClosed()) {
        const file = path.join(runDir, `${journey.id}-${name}.png`);
        await page.screenshot({ path: file, fullPage: false }).catch(() => {});
        shots.push(path.relative(process.cwd(), file));
      }
    },
    waitFor,
    sleep,
    async reloadUntil(check, options = {}) {
      return waitFor(check, { message: 'reload condition', ...options });
    },
  };
  return t;
}

/** Persist a journey result atomically next to the screenshots. */
export function writeJourneyResult(runDir, result) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, `${result.id}.json`), JSON.stringify(result, null, 2));
}
