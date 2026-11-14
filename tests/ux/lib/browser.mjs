/**
 * Shared Playwright helpers for Mosaic UX journeys.
 *
 * The QA harness targets the system Chromium (aarch64 hosts have no Playwright
 * browser download); every journey gets one fresh browser context so theme,
 * locale and storage state never leak between tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export const SYSTEM_CHROMIUM = process.env.PW_CHROMIUM || '/snap/bin/chromium';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 1024, height: 1366 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  mobileSmall: { width: 360, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
];

export async function launchBrowser({ headless = true } = {}) {
  const executablePath = fs.existsSync(SYSTEM_CHROMIUM) ? SYSTEM_CHROMIUM : undefined;
  return chromium.launch({ headless, executablePath, args: LAUNCH_ARGS });
}

/** Open a context + page and attach console/pageerror/network diagnostics. */
export async function openPage(browser, { viewport = 'desktop', colorScheme, locale = 'zh-CN', storageState } = {}) {
  const options = {
    viewport: typeof viewport === 'string' ? VIEWPORTS[viewport] : viewport,
    locale,
    ...(colorScheme ? { colorScheme } : {}),
    ...(storageState ? { storageState } : {}),
  };
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], consoleWarnings: [] };
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') diagnostics.consoleErrors.push(text);
    if (message.type() === 'warning') diagnostics.consoleWarnings.push(text);
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || '';
    // Aborted requests are deliberate in route-mocked journeys.
    if (/ERR_ABORTED/.test(failure)) return;
    diagnostics.failedRequests.push(`${request.method()} ${request.url()} ${failure}`);
  });
  return { context, page, diagnostics };
}

/** Strip volatile parts of URLs so request assertions are stable. */
export function stableUrl(routeSegment) {
  return String(routeSegment).replace(/[0-9a-f]{8,}/g, ':hash');
}

/** Read a JSON fixture through Playwright's request context (same origin). */
export async function readJson(page, route) {
  return page.evaluate(async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }, route);
}

/**
 * Mock the production Worker API surface a public page calls, so local journeys
 * never depend on the real network: stats reads, view/like/dwell beacons.
 */
export async function mockPublicApi(page, { views = 0, likes = 0, onTrack = () => {} } = {}) {
  const state = { views, likes, tracks: [] };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path.startsWith('/api/stats/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ views: state.views, likes: state.likes, dwell: 0 }),
      });
    }
    if (path.startsWith('/api/track/like/')) {
      const body = JSON.parse(route.request().postData() || '{}');
      state.likes = Math.max(0, state.likes + (body.action === 'unlike' ? -1 : 1));
      state.tracks.push(`${method} ${path}`);
      onTrack({ path, method, body });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ likes: state.likes }),
      });
    }
    if (path.startsWith('/api/track/')) {
      state.tracks.push(`${method} ${path}`);
      onTrack({ path, method, body: null });
      return route.fulfill({ status: 204, body: '' });
    }
    if (path.startsWith('/api/likes/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ likes: state.likes }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  return state;
}

/**
 * Read-only guard: every non-GET /api request is recorded and fulfilled with an
 * empty 204 (allowed: auth login/logout and anything matching `allow`).
 * Returns the array of blocked write attempts for assertions.
 */
export async function blockWrites(page, { prefixes = ['/api/'], allow = [/^\/api\/auth\/(login|logout)$/] } = {}) {
  const writes = [];
  await page.route(
    (url) => prefixes.some((prefix) => url.pathname.startsWith(prefix)),
    async (route) => {
      const method = route.request().method();
      const pathname = new URL(route.request().url()).pathname;
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue();
      if (allow.some((pattern) => pattern.test(pathname))) return route.continue();
      writes.push(`${method} ${pathname}`);
      return route.fulfill({ status: 204, body: '' });
    },
  );
  return writes;
}

export function qaRoot(root) {
  return path.join(root, 'qa/reports', `round-${process.env.QA_ROUND || '0'}`);
}
