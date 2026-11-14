import { defineJourney, waitFor } from '../lib/journey.mjs';
export const area = 'admin';
export const targets = ['admin-local'];

// Every API request is answered in memory; all other off-origin traffic is aborted.
async function installAdminMock(page, overrides = {}) {
  const requests = [];
  let savedPost = null;
  const config = {
    title: 'Fixture',
    url: 'https://example.test',
    mediaBase: 'https://example.test',
    apiBase: '/api',
    admin: { jobPollMs: 100, buildCacheMs: 60000 },
    theme: { defaultMode: 'light' },
    media: {},
  };
  let job = {
    id: 'fixture-job',
    slug: 'fixture',
    filename: 'clip.mp4',
    status: 'failed',
    error: 'Fixture upload failure',
  };
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === 'localhost' || new URL(route.request().url()).hostname === '127.0.0.1'
      ? route.continue()
      : route.abort(),
  );
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname.slice(4);
    requests.push({ path: pathname, method: req.method(), body: req.postDataJSON?.() });
    const response = await overrides.respond?.(pathname, req);
    if (response) return route.fulfill(response);
    if (overrides.expired && pathname !== '/auth/login')
      return route.fulfill({ status: 401, json: { error: 'Session expired' } });
    if (pathname === '/auth/login' && req.postDataJSON()?.password === 'wrong')
      return route.fulfill({ status: 401, json: { error: 'Wrong password' } });
    let body = { ok: true };
    if (pathname === '/auth/login') body = { token: 'qa-token' };
    else if (pathname === '/config' && route.request().method() === 'PUT') {
      body = { ok: true };
    } else if (pathname === '/config') body = config;
    else if (pathname === '/dirty') body = { dirty: true, count: 2, last: new Date().toISOString() };
    else if (pathname === '/media-jobs') body = { jobs: [job] };
    else if (pathname.endsWith('/retry')) {
      job = { ...job, status: 'pending', error: '' };
    } else if (pathname.endsWith('/cancel')) {
      job = { ...job, status: 'cancelled' };
    } else if (pathname === '/build/status') body = { status: 'unknown' };
    else if (pathname === '/build/history') body = { runs: [] };
    else if (pathname === '/stats') body = { posts: 1, categories: 1, tags: 1 };
    else if (pathname === '/stats/traffic') body = { total: 1, byDay: [], byCategory: [], byTag: [], top5: [] };
    else if (pathname === '/stats/posts') body = { stats: {} };
    else if (pathname.startsWith('/health')) body = { status: 'ok', latency: 1 };
    else if (pathname === '/disk') body = { sizeMB: 1, objects: 1, cost: 0 };
    else if (pathname === '/taxonomy')
      body = {
        capabilities: { delete: true },
        categories: [{ name: 'Fixture', slug: 'fixture', count: 1 }],
        tags: [{ name: 'test', slug: 'test', count: 1 }],
      };
    else if (pathname === '/posts')
      body = {
        posts: [
          {
            slug: 'fixture',
            title: 'Fixture post',
            category: 'Fixture',
            tags: ['test'],
            date: '2026-01-01',
            cover: '',
          },
        ],
        total: 1,
      };
    else if (pathname.startsWith('/posts/'))
      body = {
        slug: 'fixture',
        frontMatter: { title: 'Fixture post', category: 'Fixture', tags: ['test'] },
        body: 'Fixture body',
        sha: 'fixture-sha',
      };
    else if (pathname.includes('/list')) body = { photos: [], videos: [], music: [], covers: [] };
    else if (pathname === '/trash') body = { items: [] };
    else if (pathname === '/drafts' && route.request().method() === 'GET')
      body = {
        drafts: [
          {
            id: 'drf_0123456789abcdefghjkmnpq',
            title: 'Fixture draft',
            slug: 'fixture-draft',
            revision: 1,
            updatedAt: new Date().toISOString(),
            mediaCount: 1,
          },
        ],
      };
    else if (pathname === '/drafts' && route.request().method() === 'POST')
      body = {
        id: 'drf_0123456789abcdefghjkmnpq',
        revision: 1,
        updatedAt: new Date().toISOString(),
        ...JSON.parse(route.request().postData() || '{}'),
      };
    else if (pathname === '/drafts/drf_0123456789abcdefghjkmnpq' && route.request().method() === 'GET')
      body = {
        id: 'drf_0123456789abcdefghjkmnpq',
        revision: 2,
        slug: 'fixture-draft',
        title: 'Fixture cloud draft',
        body: 'Cloud draft body',
        frontMatter: { title: 'Fixture cloud draft', category: 'Fixture' },
        media: { gallery: [], videos: [], music: [], cover: null },
        baseSha: null,
        updatedAt: new Date().toISOString(),
      };
    else if (pathname.endsWith('/publish') && route.request().method() === 'POST')
      body = { ok: true, slug: 'fixture-draft', sha: 'published-sha' };
    else if (pathname === '/history' && route.request().method() === 'GET')
      body = {
        commits: [
          {
            sha: 'a'.repeat(40),
            shortSha: 'aaaaaaa',
            message: 'Fixture edit <img src=x onerror="window.__historyXss=1">',
            author: 'Fixture',
            date: new Date().toISOString(),
          },
        ],
      };
    else if (pathname === '/history/' + 'a'.repeat(40) && route.request().method() === 'GET')
      body = {
        sha: 'a'.repeat(40),
        shortSha: 'aaaaaaa',
        message: 'Fixture edit',
        author: 'Fixture',
        date: new Date().toISOString(),
        files: [
          {
            filename: 'content/posts/fixture/index.md',
            status: 'modified',
            additions: 1,
            deletions: 1,
            patch: '@@ -1 +1 @@',
          },
        ],
      };
    else if (pathname.endsWith('/restore') && route.request().method() === 'POST') body = { ok: true, files: [] };
    else if (pathname === '/themes' && route.request().method() === 'GET')
      body = {
        themes: [
          {
            id: 'default',
            name: 'Mosaic Default',
            version: '1.0.0',
            description: 'Built-in theme',
            current: true,
            values: { accent: 'blue', defaultMode: 'auto', showThemeMenu: true, allowVisitorToggle: true },
            options: {
              accent: { type: 'select', default: 'blue', options: ['blue', 'rose'], label: '强调色' },
              showThemeMenu: { type: 'boolean', default: true, label: '显示主题菜单' },
            },
          },
          {
            id: 'starter',
            name: 'Starter',
            version: '1.0.0',
            description: 'Tiny theme',
            current: false,
            values: {},
            options: { accent: { type: 'color', default: '#4361ee', label: '强调色' } },
          },
        ],
        current: { package: 'default', options: {} },
      };
    else if (pathname === '/themes/apply' && route.request().method() === 'POST')
      body = { ok: true, themePackage: 'starter', themeOptions: {} };
    else if (pathname === '/media/interpolate' && route.request().method() === 'POST')
      body = { ok: true, enqueued: 1, tasks: [], skipped: [] };
    else if (pathname === '/previews' && route.request().method() === 'POST')
      body = {
        previewId: 'prv_0123456789abcdefghjkmnpq',
        token: 'preview-token',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        status: 'queued',
      };
    else if (pathname === '/previews/prv_0123456789abcdefghjkmnpq')
      body = { id: 'prv_0123456789abcdefghjkmnpq', status: 'ready' };
    else if (pathname.startsWith('/drafts/drf_') && route.request().method() === 'PUT') {
      const input = JSON.parse(route.request().postData() || '{}');
      body = {
        id: 'drf_0123456789abcdefghjkmnpq',
        revision: (Number(input.revision) || 1) + 1,
        updatedAt: new Date().toISOString(),
        ...input,
      };
    } else if (pathname === '/assets')
      body = {
        assets: [
          {
            id: 'ast_0123456789abcdefghjkmnpq',
            filename: 'library-photo.jpg',
            folder: 'photos',
            status: 'ready',
            published: true,
            usage: [{ slug: 'fixture', kind: 'published', role: 'gallery', order: 0 }],
          },
          {
            id: 'ast_0123456789abcdefghjkmnpr',
            filename: 'clip.mp4',
            folder: 'videos',
            status: 'ready',
            published: true,
            sourceAvailable: true,
          },
        ],
        total: 2,
      };
    if (pathname === '/cleanup' && req.method() === 'GET')
      body = { orphans: [{ key: 'orphan.jpg', size: 1024 }], totalOrphans: 1, totalSize: 1024 };
    if (pathname === '/cleanup' && req.method() === 'DELETE') body = { deleted: 1, freedMB: 0.01 };
    await route.fulfill({ json: body });
  });
  return {
    requests,
    overrides,
    get savedPost() {
      return savedPost;
    },
  };
}
async function login(t, options = {}) {
  const mock = await installAdminMock(t.page, options);
  await t.goto('/');
  await t.page.locator('#login-password').fill('fixture-password');
  await t.page.locator('#login-btn').click();
  await t.page.locator('#app').waitFor({ state: 'visible', timeout: 10000 });
  await waitFor(() => t.page.evaluate(() => location.hash === '#dashboard' || location.hash === ''), {
    timeout: 10000,
  });
  return mock;
}
async function nav(t, name) {
  await t.page.locator(`a.nav-item[data-page="${name}"]`).click();
  await waitFor(() => t.page.evaluate((n) => location.hash.startsWith('#' + n), name), { timeout: 10000 });
  await t.page.locator('#main-content .page-anim').first().waitFor({ timeout: 10000 });
}
const has = (m, method, path) => m.requests.some((r) => r.method === method && r.path === path);
const journey = (id, title, steps, extra = {}) =>
  defineJourney({ id, title, priority: 'P1', timeoutMs: 25000, steps, ...extra });
export const journeys = [
  journey('admin-dashboard-cards', 'Dashboard cards load independently and retry only failed metrics', async (t) => {
    const traffic = Promise.withResolvers(),
      disk = Promise.withResolvers(),
      health = Promise.withResolvers();
    let trafficRequests = 0;
    const m = await login(t, {
      respond: (path) => {
        if (path === '/stats/traffic')
          return ++trafficRequests === 1 ? traffic.promise : { json: { total: 9, byDay: [], top5: [] } };
        if (path === '/disk') return disk.promise;
        if (path === '/health/github') return health.promise;
      },
    });
    const value = (key) => t.page.locator(`[data-dashboard-${key}] .dash-big-num`);
    try {
      await waitFor(async () => (await value('posts').innerText()) === '1', {
        message: 'posts appear while other requests are pending',
      });
      t.assertEqual(await value('total-views').innerText(), '...', 'total views wait for traffic');
      t.assertEqual(
        await value('today-views').innerText(),
        '...',
        'today views wait for traffic instead of showing zero',
      );
      t.assertEqual(await value('disk').innerText(), '... MB', 'disk has its own placeholder');
      disk.resolve({ json: { sizeMB: 2, objects: 4, cost: 0 } });
      await waitFor(async () => (await value('disk').innerText()) === '2 MB', {
        message: 'disk appears independently',
      });
      t.assertEqual(await value('total-views').innerText(), '...', 'disk completion does not settle traffic');
      traffic.resolve({ status: 503, json: { error: 'Fixture traffic unavailable' } });
      await t.page.locator('[data-metrics-retry]').waitFor();
      t.assertEqual(await value('total-views').innerText(), '—', 'failed total views show an unavailable state');
      t.assertEqual(await value('today-views').innerText(), '—', 'failed today views do not show zero');
      t.assertEqual(await value('posts').innerText(), '1', 'failure preserves loaded cards');
      await t.page.locator('[data-metrics-retry]').click();
      await waitFor(async () => (await value('total-views').innerText()) === '9', {
        message: 'retry updates traffic before health settles',
      });
      t.assertEqual(await value('today-views').innerText(), '0', 'loaded empty traffic legitimately shows zero');
      t.assertEqual(await t.page.locator('[data-metrics-retry]').count(), 0, 'successful retry clears partial error');
      t.assertEqual(m.requests.filter((r) => r.path === '/stats').length, 1, 'retry leaves successful stats alone');
      t.assertEqual(m.requests.filter((r) => r.path === '/disk').length, 1, 'retry leaves successful disk alone');
    } finally {
      traffic.resolve({ json: { total: 9, byDay: [], top5: [] } });
      disk.resolve({ json: { sizeMB: 2, objects: 4, cost: 0 } });
      health.resolve({ json: { status: 'ok' } });
    }
  }),
  ...['zh', 'en'].map((lang) =>
    journey(
      `admin-dashboard-categories-${lang}`,
      'Dashboard groups missing categories and deduplicates donut labels',
      async (t) => {
        await t.page.addInitScript((lang) => localStorage.setItem('mosaic_admin_lang', lang), lang);
        const label = lang === 'en' ? 'Uncategorized' : '未分类';
        await login(t, {
          respond: (path) =>
            path === '/taxonomy'
              ? {
                  json: {
                    categories: [null, undefined, '', '  ', 'null', ' NULL ', 'uncategorized', label]
                      .map((name) => ({ name, count: 1 }))
                      .concat([
                        { name: 'Fixture', count: 2 },
                        { name: 'Fixture', count: 3 },
                      ]),
                    tags: [],
                  },
                }
              : undefined,
        });
        await t.page.waitForFunction(() => !!window.Chart?.getChart(document.querySelector('#chart-categories')));
        const chart = await t.page.evaluate(() => {
          const chart = window.Chart.getChart(document.querySelector('#chart-categories'));
          return { labels: chart.data.labels, values: chart.data.datasets[0].data };
        });
        t.assertEqual(
          JSON.stringify(chart.labels),
          JSON.stringify([label, 'Fixture']),
          'localized, unique category labels',
        );
        t.assertEqual(
          JSON.stringify(chart.values),
          JSON.stringify([8, 5]),
          'merged slices retain every category count',
        );
      },
    ),
  ),
  ...['missing', 'disabled', '404', '503'].map((mode) =>
    journey(
      `admin-taxonomy-capability-${mode}`,
      'Older or unavailable taxonomy APIs disable delete without writing',
      async (t) => {
        const m = await login(t, {
          respond: (path) =>
            path === '/taxonomy'
              ? {
                  status: Number(mode) || 200,
                  json: {
                    categories: [{ name: 'Fixture', count: 1 }],
                    tags: [{ name: 'test', count: 1 }],
                    ...(mode === 'disabled' ? { capabilities: { delete: false } } : {}),
                  },
                }
              : undefined,
        });
        await nav(t, 'taxonomy');
        await t.page.locator('.tax-layout').waitFor();
        t.assertEqual(
          await t.page.locator('[onclick^="removeCategory"], [onclick^="removeTag"]').count(),
          0,
          'delete controls require an explicit capability',
        );
        t.assert(
          (await t.page.locator('.draft-banner').innerText()).includes('latest Worker API'),
          'compatibility notice shown',
        );
        t.assert(
          !m.requests.some((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method) && r.path !== '/auth/login'),
          'capability fallback never writes',
        );
      },
    ),
  ),
  journey(
    'admin-login',
    'Login validation, error and persistence',
    async (t) => {
      const m = await installAdminMock(t.page);
      await t.goto('/');
      await t.page.locator('#login-btn').click();
      t.assert((await t.page.locator('#login-error').innerText()).length > 0, 'empty password has inline error');
      await t.page.locator('#login-password').fill('wrong');
      await t.page.locator('#login-btn').click();
      await waitFor(() => has(m, 'POST', '/auth/login'));
      await waitFor(async () => (await t.page.locator('#login-error').innerText()).length > 0);
      await t.page.locator('#login-password').fill('fixture-password');
      await t.page.locator('#login-btn').click();
      await t.page.locator('#app').waitFor({ state: 'visible' });
      t.assertEqual(
        await t.page.evaluate(() => localStorage.getItem('mosaic_admin_token')),
        'qa-token',
        'token persists',
      );
      await t.page.reload();
      await t.page.locator('#app').waitFor({ state: 'visible' });
      t.assert(has(m, 'POST', '/auth/login'), 'login request sent');
    },
    { priority: 'P0' },
  ),
  journey('admin-editor', 'Editor draft and command palette', async (t) => {
    const m = await login(t);
    await nav(t, 'drafts');
    await t.page.locator('[data-open-draft]').click();
    await t.page.locator('#fm-title').waitFor();
    await t.page.locator('#fm-title').fill('Edited title');
    await t.page.locator('#fm-category').fill('Fixture');
    await t.page.locator('#fm-tags').fill('test, new');
    await t.page.locator('button[onclick="window.saveDraftNow()"]').click();
    await waitFor(() => has(m, 'PUT', '/drafts/drf_0123456789abcdefghjkmnpq'));
    const payload = m.requests.find((r) => r.method === 'PUT' && r.path.startsWith('/drafts/')).body;
    t.assert(payload.title === 'Edited title' || payload.frontMatter?.title === 'Edited title', 'draft carries title');
    await t.page.keyboard.press('Control+k');
    t.assert((await t.page.locator('.modal-overlay, [role="dialog"]').count()) > 0, 'command palette opens');
  }),
  journey('admin-posts', 'Posts combined filters and opening an item', async (t) => {
    await login(t);
    await nav(t, 'posts');
    await t.page.locator('#post-search').fill('Fixture');
    await t.page.locator('#post-cat-filter').selectOption({ label: 'Fixture' });
    await waitFor(async () => (await t.page.locator('#main-content').innerText()).includes('Fixture post'));
    await t.page.locator('#post-search').fill('no such post');
    await waitFor(async () => await t.page.locator('#posts-empty').isVisible());
    await t.page.locator('#post-search').fill('Fixture');
    await t.page.locator('#posts-table a').first().click();
    await t.page.locator('#fm-title').waitFor();
    t.assertEqual(await t.page.locator('#fm-title').inputValue(), 'Fixture post', 'post opens populated editor');
  }),
  journey('admin-drafts', 'Draft preview and publish', async (t) => {
    const m = await login(t);
    await nav(t, 'drafts');
    await t.page.locator('[data-open-draft]').click();
    await t.page.locator('button[onclick="window.openPreview()"]').click();
    await waitFor(() => has(m, 'POST', '/previews'));
    await t.page.locator('button[onclick="window.publishDraft()"]').click();
    await waitFor(() => has(m, 'POST', '/drafts/drf_0123456789abcdefghjkmnpq/publish'));
    t.assert((await t.page.locator('body').innerText()).length > 0, 'interface remains visible');
  }),
  journey('admin-library', 'Library asset delete warning', async (t) => {
    await login(t);
    await nav(t, 'library');
    await t.page.locator('.asset-card').first().click();
    await t.page.locator('.asset-detail').waitFor();
    await t.page.locator('.modal-overlay .btn-danger').click();
    t.assert(
      (await t.page.locator('.modal-overlay').last().innerText()).includes('1'),
      'warning identifies use by a post',
    );
  }),
  journey('admin-taxonomy', 'Taxonomy support probe and add category', async (t) => {
    const m = await login(t);
    await nav(t, 'taxonomy');
    await t.page.locator('.tax-layout').waitFor();
    t.assert(has(m, 'GET', '/taxonomy'), 'read-only taxonomy capability requested');
    t.assert(
      !m.requests.some((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method) && r.path !== '/auth/login'),
      'opening taxonomy does not write',
    );
    t.assertEqual(
      await t.page.locator('.tax-row-actions [onclick^="removeCategory"]').count(),
      1,
      'supported category delete is available',
    );
    t.assertEqual(await t.page.locator('[onclick^="removeTag"]').count(), 1, 'supported tag delete is available');
    await t.page.locator('[onclick="addCategory()"]').click();
    await t.page.locator('.modal-overlay input').fill('New category');
    await t.page.locator('.modal-overlay .btn-primary').click();
    await t.page.locator('#fm-category').waitFor();
    t.assertEqual(await t.page.locator('#fm-category').inputValue(), 'New category', 'category prefilled');
  }),
  journey('admin-config', 'Config dirty indicator and save', async (t) => {
    const m = await login(t);
    await nav(t, 'config');
    await t.page.locator('[data-config="title"]').fill('Changed fixture');
    await t.page.locator('#config-discard-btn').waitFor({ state: 'visible' });
    await t.page.locator('.page-header .btn-primary').click();
    await waitFor(() => has(m, 'PUT', '/config'));
    t.assertEqual(
      m.requests.find((r) => r.method === 'PUT' && r.path === '/config').body.title,
      'Changed fixture',
      'config payload',
    );
  }),
  journey('admin-themes', 'Theme option is applied', async (t) => {
    const m = await login(t);
    await nav(t, 'themes');
    await t.page.locator('#theme-accent').first().selectOption('rose');
    await t.page.locator('[data-apply-theme="default"]').click();
    await waitFor(() => has(m, 'POST', '/themes/apply'));
    t.assert(
      m.requests.find((r) => r.path === '/themes/apply').body.options?.accent === 'rose',
      'chosen theme option submitted',
    );
  }),
  journey('admin-build', 'Build status and history render', async (t) => {
    const m = await login(t);
    await nav(t, 'build');
    await t.page.locator('[data-build-trigger]').first().waitFor();
    t.assert(has(m, 'GET', '/build/status') && has(m, 'GET', '/build/history'), 'status and history fetched');
    const count = m.requests.filter((r) => r.method === 'GET' && r.path === '/build/status').length;
    m.overrides.respond = (path) =>
      path === '/build/status' ? { json: { status: 'completed', conclusion: 'success', runNumber: 37 } } : undefined;
    await t.page.locator('[onclick="window.mosaicRefreshBuild?.()"]').click();
    await waitFor(
      () => m.requests.filter((r) => r.method === 'GET' && r.path === '/build/status').length === count + 1,
      { timeout: 1500, message: 'fresh GET on Refresh while the 60s cache is warm' },
    );
    await waitFor(async () => (await t.page.locator('#build-status-card').innerText()).includes('#37'), {
      message: 'refreshed server status rendered',
    });
    t.assert(await t.page.locator('#build-status-card').isVisible(), 'status remains visible after refresh');
  }),
  journey('admin-history', 'History diff and restore confirmation', async (t) => {
    const m = await login(t);
    await nav(t, 'history');
    await t.page.locator('.history-row').click();
    await t.page.locator('.history-file summary').click();
    t.assert((await t.page.locator('.history-file').innerText()).includes('@@ -1 +1 @@'), 'diff rendered');
    await t.page.getByRole('button', { name: '恢复整次提交' }).click();
    await t.page.locator('.modal-overlay').last().locator('.btn-danger').click();
    await waitFor(() => m.requests.some((r) => r.method === 'POST' && r.path.endsWith('/restore')));
  }),
  journey('admin-tasks', 'Tasks retry, cancel, and stop polling', async (t) => {
    const m = await login(t);
    await nav(t, 'tasks');
    await t.page.locator('[data-job-action="retry"]').click();
    await t.page.locator('[data-job-action="cancel"]').waitFor();
    await t.page.locator('[data-job-action="cancel"]').click();
    await t.page.locator('[data-job-action="retry"]').waitFor();
    t.assert(
      has(m, 'POST', '/media-jobs/fixture-job/retry') && has(m, 'POST', '/media-jobs/fixture-job/cancel'),
      'retry and cancel requests',
    );
    await nav(t, 'posts');
    await t.sleep(300);
    const n = m.requests.filter((r) => r.path === '/media-jobs').length;
    await t.sleep(400);
    t.assertEqual(m.requests.filter((r) => r.path === '/media-jobs').length, n, 'polling stops');
  }),
  journey('admin-cleanup', 'Cleanup typed confirmation and result', async (t) => {
    const m = await login(t);
    await nav(t, 'cleanup');
    t.assert((await t.page.locator('.file-list').innerText()).includes('orphan.jpg'), 'candidate listed');
    await t.page.locator('#btn-cleanup').click();
    await t.page.locator('#modal-confirm-input').fill('1');
    await t.page.locator('.modal-overlay .btn-danger').click();
    await waitFor(() => has(m, 'DELETE', '/cleanup'));
    await t.page.locator('.cleanup-result').waitFor();
    t.assert((await t.page.locator('.cleanup-result').innerText()).length > 0, 'cleanup result visible');
  }),
  journey(
    'admin-mobile',
    'Mobile drawer and editor fit',
    async (t) => {
      await login(t);
      await t.page.locator('.sidebar-toggle').click();
      await nav(t, 'editor');
      await t.page.locator('#fm-title').fill('Mobile title');
      t.assert(
        await t.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'no horizontal overflow',
      );
    },
    { viewport: 'mobile' },
  ),
  journey('admin-session', 'Session expiry returns to login', async (t) => {
    const m = await login(t);
    m.overrides.expired = true;
    await nav(t, 'posts');
    await t.page.locator('#login-screen').waitFor({ state: 'visible', timeout: 8000 });
    t.assert(await t.page.locator('#login-password').isVisible(), 'login form shown');
  }),
];
