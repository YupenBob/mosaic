import assert from 'node:assert/strict';
import { defineJourney, waitFor } from '../lib/journey.mjs';
import { login, nav } from './admin-writes.spec.mjs';
export const area = 'admin';
export const targets = ['admin-local'];
const J = (id, title, steps) => defineJourney({ id, title, priority: 'P1', timeoutMs: 45000, steps });
const request = async (m, method, path) =>
  waitFor(() => m.requests.find((r) => r.method === method && r.path === path), { message: `${method} ${path}` });
const shot = (t, id) => t.shot(id);
const typedConfirmation = async (t, expected, unchanged) => {
  const input = t.page.locator('#modal-confirm-input');
  const button = t.page.locator('.modal-overlay .btn-danger');
  assert(await button.isDisabled(), 'confirmation starts disabled');
  await t.sleep(250); // Allow the dialog's initial focus timer to settle.
  await input.focus();
  await input.press('Shift+Tab');
  assert(await t.page.locator('.modal-overlay .btn-secondary').evaluate((el) => el === document.activeElement));
  await t.page.keyboard.press('Tab');
  assert(
    await input.evaluate((el) => el === document.activeElement),
    'disabled confirmation stays out of the tab order',
  );
  for (const value of ['wrong', expected.toUpperCase(), ` ${expected}`, `${expected} `].filter(
    (value) => value !== expected,
  )) {
    await input.fill(value);
    assert(await button.isDisabled(), 'only the exact text enables confirmation');
    await input.press('Enter');
    await unchanged();
  }
  await input.fill(expected);
  assert(await button.isEnabled());
  // A programmatic change without an input event still must fail click-time validation.
  await input.evaluate((el) => {
    el.value = 'wrong';
  });
  await button.click();
  assert(await t.page.locator('#modal-confirm-error').isVisible());
  await unchanged();
  await input.fill('wrong');
  assert(await button.isDisabled());
  await input.fill(expected);
  assert(await button.isEnabled());
  return button;
};
export const journeys = [
  J('deep-config', 'Config reset, save and guard', async (t) => {
    const m = await login(t);
    await nav(t, 'config');
    const field = t.page.locator('[data-config="title"]');
    await field.fill('Changed');
    await t.page.locator('#config-discard-btn').click();
    await t.page.locator('.modal-overlay .btn-primary').click();
    await waitFor(async () => (await field.inputValue()) === 'Fixture');
    await field.fill('Saved title');
    await t.page.locator('.page-header .btn-primary').click();
    const r = await request(m, 'PUT', '/config');
    assert.equal(r.body.title, 'Saved title');
    await waitFor(async () => !(await t.page.locator('#config-discard-btn').isVisible()));
    await field.fill('Unsaved');
    await t.page.locator('a.nav-item[data-page="posts"]').click();
    await t.page.locator('.modal-overlay').last().waitFor();
    await shot(t, 'AD-33-guard');
  }),
  J('deep-taxonomy-rename', 'Category and tag rename send names and show feedback', async (t) => {
    const m = await login(t);
    await nav(t, 'taxonomy');
    await t.page.locator('.tax-layout').waitFor();
    assert(!m.requests.some((r) => r.method === 'DELETE'));
    for (const [kind, oldName, newName] of [
      ['category', 'Fixture', 'Renamed'],
      ['tag', 'test', 'renamed-tag'],
    ]) {
      await t.page
        .locator(`[onclick^="rename${kind === 'category' ? 'Category' : 'Tag'}"]`)
        .first()
        .click();
      await t.page.locator('.modal-overlay input').fill(newName);
      await t.page.locator('.modal-overlay .btn-primary').click();
      const r = await request(m, 'PUT', `/taxonomy/${kind}`);
      assert.deepEqual(r.body, { oldName, newName });
      await waitFor(async () => (await t.page.locator('body').innerText()).includes(newName));
    }
    await shot(t, 'AD-60-rename');
  }),
  J('deep-taxonomy-delete', 'Taxonomy deletion requires the affected count', async (t) => {
    const m = await login(t);
    await nav(t, 'taxonomy');
    await t.page.locator('[onclick^="removeCategory"]').click();
    const button = await typedConfirmation(t, '1', () => assert(!m.requests.some((r) => r.method === 'DELETE')));
    await button.click();
    const r = await request(m, 'DELETE', '/taxonomy/category');
    assert.deepEqual(r.body, { name: 'Fixture' });
    await waitFor(() => m.requests.filter((x) => x.path === '/taxonomy' && x.method === 'GET').length >= 2);
  }),
  J('deep-cleanup', 'Cleanup lists candidates and confirms deletion', async (t) => {
    const m = await login(t);
    await nav(t, 'cleanup');
    assert((await t.page.locator('.file-list').innerText()).includes('orphan.jpg'));
    assert(!m.requests.some((r) => r.path === '/cleanup' && r.method === 'POST'));
    await t.page.locator('#btn-cleanup').click();
    const button = await typedConfirmation(t, '1', () =>
      assert(!m.requests.some((r) => r.path === '/cleanup' && r.method === 'DELETE')),
    );
    await button.click();
    const r = await request(m, 'DELETE', '/cleanup');
    assert.equal(r.body, null);
    await t.page.locator('.cleanup-result').waitFor();
    await shot(t, 'AD-51-result');
  }),
  J('deep-tasks', 'Job retry and cancel update rows and stop polling', async (t) => {
    const m = await login(t);
    await nav(t, 'tasks');
    await t.page.locator('[data-job-action="retry"]').click();
    const retry = await request(m, 'POST', '/media-jobs/fixture-job/retry');
    assert.equal(retry.body, null);
    await t.page.locator('[data-job-action="cancel"]').waitFor();
    await t.page.locator('[data-job-action="cancel"]').click();
    const cancel = await request(m, 'POST', '/media-jobs/fixture-job/cancel');
    assert.equal(cancel.body, null);
    await t.page.locator('[data-job-action="retry"]').waitFor();
    await nav(t, 'posts');
    await t.sleep(300);
    const n = m.requests.filter((r) => r.path === '/media-jobs').length;
    await t.sleep(500);
    assert.equal(m.requests.filter((r) => r.path === '/media-jobs').length, n);
  }),
  J('deep-history', 'History escapes commit messages and restores target', async (t) => {
    const m = await login(t);
    await nav(t, 'history');
    await t.page.locator('.history-row').waitFor();
    assert.equal(await t.page.evaluate(() => window.__historyXss), undefined);
    assert.equal(await t.page.locator('.history-row img').count(), 0);
    await t.page.locator('.history-row').click();
    await t.page.locator('.history-file summary').click();
    assert((await t.page.locator('.history-file').innerText()).includes('@@ -1 +1 @@'));
    await t.page.getByRole('button', { name: '恢复整次提交' }).click();
    await t.page.locator('.modal-overlay').last().locator('.btn-danger').click();
    // The server contract is path-based: SHA selects the commit in the URL; an empty path restores all files.
    const r = await request(m, 'POST', `/history/${'a'.repeat(40)}/restore`);
    assert.deepEqual(r.body, { path: '' });
    await shot(t, 'AD-43-restore');
  }),
  J('deep-theme', 'Theme option applies and shows feedback', async (t) => {
    const m = await login(t);
    await nav(t, 'themes');
    await t.page.locator('#theme-accent').first().selectOption('rose');
    await t.page.locator('[data-apply-theme="default"]').click();
    const r = await request(m, 'POST', '/themes/apply');
    assert.equal(r.body.options.accent, 'rose');
    assert.equal(r.body.id, 'default');
    await waitFor(() => m.requests.filter((x) => x.path === '/themes' && x.method === 'GET').length >= 2);
    await t.page.locator('#theme-accent').first().waitFor();
  }),
  J('deep-draft-discard', 'Discard a cloud draft and render its empty state', async (t) => {
    const m = await login(t);
    await nav(t, 'drafts');
    await t.page.locator('[data-delete-draft]').click();
    assert(!m.requests.some((r) => r.method === 'DELETE' && r.path.startsWith('/drafts/')));
    await t.page.locator('.modal-overlay .btn-danger').click();
    const r = await request(m, 'DELETE', '/drafts/drf_0123456789abcdefghjkmnpq');
    assert.equal(r.body, null);
    await t.page.locator('[data-new-draft-inline]').waitFor();
    assert.equal(await t.page.locator('.draft-row').count(), 0);
    await shot(t, 'AD-20-empty');
  }),
  J('deep-editor-guard', 'Editor guard cancels and confirms navigation', async (t) => {
    await login(t);
    await nav(t, 'editor');
    await t.page.locator('#fm-title').fill('Unsaved editor title');
    await t.page.locator('a.nav-item[data-page="posts"]').click();
    await t.page.locator('.modal-overlay').waitFor();
    await t.page.locator('.modal-overlay .btn-secondary').click();
    assert.equal(await t.page.locator('#fm-title').inputValue(), 'Unsaved editor title');
    await t.page.locator('a.nav-item[data-page="posts"]').click();
    await t.page.locator('.modal-overlay .btn-primary').click();
    await t.page.locator('#post-search').waitFor();
    assert.equal(await t.page.evaluate(() => location.hash), '#posts');
  }),
  J('deep-draft-publish', 'Cloud draft sends edited metadata and publishes', async (t) => {
    const m = await login(t);
    await nav(t, 'drafts');
    await t.page.locator('[data-open-draft]').click();
    await t.page.locator('#fm-title').fill('Deep title');
    await t.page.locator('#fm-category').fill('');
    await t.page.locator('#fm-tags').fill('one, two');
    await t.page.locator('#fm-desc').fill('Description');
    await t.page.locator('#fm-date').fill('2026-08-04');
    await t.page.locator('.fm-text-block').first().fill('Deep body');
    await t.page.locator('button[onclick="window.saveDraftNow()"]').click();
    const r = await request(m, 'PUT', '/drafts/drf_0123456789abcdefghjkmnpq');
    assert.equal(r.body.title, 'Deep title');
    assert.equal(r.body.slug, 'fixture-draft');
    assert.equal(r.body.body, 'Deep body\n');
    assert.equal(r.body.frontMatter.category, null);
    assert.deepEqual(r.body.frontMatter.tags, ['one', 'two']);
    assert.equal(r.body.frontMatter.description, 'Description');
    assert.equal(r.body.frontMatter.date, '2026-08-04T00:00:00.000Z');
    assert.deepEqual(r.body.media, { gallery: [], videos: [], music: [], cover: null });
    await t.page.locator('.toast').first().waitFor();
    await t.page.locator('button[onclick="window.publishDraft()"]').click();
    const p = await request(m, 'POST', '/drafts/drf_0123456789abcdefghjkmnpq/publish');
    assert.equal(p.body, null);
    await t.page.locator('#post-search').waitFor();
    assert((await t.page.locator('.toast-success').last().innerText()).includes('已发布'));
    assert.equal(await t.page.evaluate(() => localStorage.getItem('mosaic_admin_token')), 'qa-token');
    await shot(t, 'AD-21-published');
  }),

  J('r10-session-save', 'Expired saves retain editor fields across repeated re-login', async (t) => {
    let expire = false;
    let delay = 0;
    const path = '/drafts/drf_0123456789abcdefghjkmnpq';
    const m = await login(t, {
      respond: async (url, req) => {
        if (url === path && req.method() === 'GET') await t.sleep(250);
        if (url === path && req.method() === 'PUT') {
          if (expire) {
            await t.sleep(delay);
            return { status: 401, json: { error: 'Session expired' } };
          }
          return { json: { ...req.postDataJSON(), revision: 3 } };
        }
      },
    });
    await nav(t, 'drafts');
    await t.page.locator('[data-open-draft]').click();
    for (const wait of [0, 400]) {
      delay = wait;
      const title = `Session retained title ${wait}`;
      await t.page.locator('#fm-title').fill(title);
      await t.page.locator('#fm-desc').fill('Retained description');
      await t.page.locator('.fm-text-block').first().fill('Retained body');
      expire = true;
      const writes = () => m.requests.filter((r) => r.method === 'PUT' && r.path === path);
      const count = writes().length;
      await t.page.locator('button[onclick="window.saveDraftNow()"]').click();
      await waitFor(() => writes().length > count);
      assert.equal(writes().at(-1).body.title, title);
      // Edits made while a slow save is in flight must survive as well.
      const retainedTitle = wait ? `${title} while saving` : title;
      if (wait) await t.page.locator('#fm-title').fill(retainedTitle);
      await t.page.locator('#login-screen').waitFor({ state: 'visible' });
      assert(await t.page.locator('#login-btn').isEnabled());
      expire = false;
      await t.page.locator('#login-password').fill('fixture-password');
      await t.page.locator('#login-btn').click();
      await t.page.locator('#fm-title').waitFor();
      assert.equal(await t.page.locator('#fm-title').inputValue(), retainedTitle);
      assert.equal(await t.page.locator('#fm-desc').inputValue(), 'Retained description');
      assert.equal(await t.page.locator('.fm-text-block').first().inputValue(), 'Retained body');
      assert(await t.page.locator('#login-btn').isEnabled());
      await t.page.locator('button[onclick="window.saveDraftNow()"]').click();
      await waitFor(() => writes().length > count + 1);
      assert.equal(writes().at(-1).body.title, retainedTitle);
      assert.equal(writes().at(-1).body.frontMatter.description, 'Retained description');
      assert.equal(writes().at(-1).body.body, 'Retained body\n');
      await t.page.locator('.toast-success').last().waitFor();
    }
    await shot(t, 'ADR-56-session-return');
  }),
  J('r10-upload-direct', 'Direct upload falls back after presign failure and displays job progress', async (t) => {
    let polls = 0;
    const m = await login(t, {
      respond: (path) => {
        if (path === '/upload/presign') return { status: 404, json: { error: 'Unavailable' } };
        if (path === '/upload/direct/fixture/tiny.jpg') return { json: { taskId: 'upload-job' } };
        if (path === '/media-jobs/upload-job')
          return {
            json: { status: ++polls < 3 ? 'running' : 'ready', current: polls === 2 ? 'Processing fixture' : '' },
          };
      },
    });
    await nav(t, 'editor');
    await t.page.locator('#fm-slug').fill('fixture');
    await t.page
      .locator('#editor-media-input')
      .setInputFiles({ name: 'tiny.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fixture') });
    const presign = await request(m, 'POST', '/upload/presign');
    assert.deepEqual(presign.body, { slug: 'fixture', filename: 'tiny.jpg', contentType: 'image/jpeg' });
    const direct = await request(m, 'POST', '/upload/direct/fixture/tiny.jpg');
    assert.equal(direct.body, 'fixture');
    assert.equal(direct.headers['content-type'], 'image/jpeg');
    await waitFor(async () => (await t.page.locator('.upload-item-meta').innerText()).includes('Processing fixture'));
    await shot(t, 'ADR-24-upload-progress');
    await waitFor(() => polls >= 3);
    await t.page.locator('.upload-done').waitFor();
    assert.equal(await t.page.locator('.upload-item-fill').evaluate((el) => el.style.width), '100%');
  }),
  ...[
    { status: 404 },
    { status: 410 },
    { status: 400 },
    { status: 500 },
    { status: 404, resume: true },
    { status: 500, resume: true },
  ].map(({ status, resume }) =>
    J(
      `r10-multipart-${status}${resume ? '-resume' : ''}`,
      `Multipart init ${status}${resume ? ' after stale resume' : ''} ${[404, 410].includes(status) ? 'falls back to direct upload' : 'keeps the error UI'}`,
      async (t) => {
        let starts = 0;
        const m = await login(t, {
          respond: (path, req) => {
            if (path === '/config' && req.method() === 'GET')
              return {
                json: {
                  title: 'Fixture',
                  url: 'https://example.test',
                  mediaBase: 'https://example.test',
                  apiBase: '/api',
                  admin: { jobPollMs: 100 },
                  upload: { multipartThreshold: 1 },
                  theme: { defaultMode: 'light' },
                  media: {},
                },
              };
            if (path === '/upload/multipart/start')
              return { status: resume && ++starts === 1 ? 404 : status, json: { error: 'Unavailable' } };
          },
        });
        await nav(t, 'editor');
        await t.page.locator('#fm-slug').fill('fixture');
        if (resume)
          await t.page.evaluate(() =>
            localStorage.setItem(
              'mosaic_mp_fixture/tiny.jpg',
              JSON.stringify({ uploadId: 'stale-upload', size: 7, partSize: 7, partCount: 1 }),
            ),
          );
        await t.page
          .locator('#editor-media-input')
          .setInputFiles({ name: 'tiny.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fixture') });
        const r = await request(m, 'POST', '/upload/multipart/start');
        assert.deepEqual(r.body, {
          slug: 'fixture',
          filename: 'tiny.jpg',
          size: 7,
          contentType: 'image/jpeg',
          ...(resume ? { uploadId: 'stale-upload' } : {}),
        });
        if ([404, 410].includes(status)) {
          const direct = await request(m, 'POST', '/upload/direct/fixture/tiny.jpg');
          assert.equal(direct.body, 'fixture');
          assert.equal(direct.headers['content-type'], 'image/jpeg');
          await t.page.locator('.upload-done').waitFor();
          assert.equal(await t.page.locator('.upload-error').count(), 0);
        } else {
          await t.page.locator('.upload-error').waitFor();
          assert(!m.requests.some((x) => x.path.startsWith('/upload/direct/') && x.method === 'POST'));
        }
        const startRequests = m.requests.filter((x) => x.path === '/upload/multipart/start');
        assert.equal(startRequests.length, resume ? 2 : 1);
        if (resume)
          assert.deepEqual(startRequests[1].body, {
            slug: 'fixture',
            filename: 'tiny.jpg',
            size: 7,
            contentType: 'image/jpeg',
          });
        assert(!m.requests.some((x) => ['/upload/presign', '/upload/multipart/complete'].includes(x.path)));
        assert.equal(await t.page.evaluate(() => localStorage.getItem('mosaic_mp_fixture/tiny.jpg')), null);
      },
    ),
  ),
  J('r10-build-history', 'Build starts, updates, cancels and displays run history', async (t) => {
    let running = false;
    const run = {
      id: 37,
      runNumber: 37,
      status: 'in_progress',
      displayTitle: 'Fixture pipeline',
      createdAt: new Date().toISOString(),
      steps: [{ name: 'Install dependencies', status: 'in_progress' }],
    };
    const m = await login(t, {
      respond: (path, req) => {
        if (path === '/build' && req.method() === 'POST') {
          running = true;
          return { json: { ok: true } };
        }
        if (path === '/build/status') return { json: running ? run : { status: 'unknown' } };
        if (path === '/build/history')
          return { json: { runs: [{ ...run, status: 'completed', conclusion: 'success' }] } };
        if (path === '/build/run/37') return { json: run };
        if (path === '/build/cancel' && req.method() === 'POST') return { json: { runNumber: 37 } };
      },
    });
    await nav(t, 'build');
    assert((await t.page.locator('#build-history').innerText()).includes('Fixture pipeline'));
    await t.page.locator('[data-build-trigger]').first().click();
    await t.page.locator('.modal-overlay .btn-primary').click();
    assert.equal((await request(m, 'POST', '/build')).body, null);
    await t.page.locator('[onclick="window.mosaicRefreshBuild?.()"]').click();
    await t.page.locator('[data-build-cancel]').waitFor();
    await shot(t, 'ADR-40-build-running');
    await t.page.locator('[data-build-cancel]').click();
    await t.page.locator('.modal-overlay .btn-danger').click();
    assert.equal((await request(m, 'POST', '/build/cancel')).body, null);
    await t.page.locator('.build-history-main').first().click();
    await t.page.locator('#build-detail-root').waitFor();
    assert((await t.page.locator('#main-content').innerText()).includes('Fixture pipeline'));
    assert.equal((await request(m, 'GET', '/build/run/37')).body, null);
    await shot(t, 'ADR-40-build-detail');
    await nav(t, 'posts');
    await t.sleep(300);
    const count = m.requests.filter((r) => r.method === 'GET' && r.path === '/build/status').length;
    await t.sleep(2100);
    assert.equal(m.requests.filter((r) => r.method === 'GET' && r.path === '/build/status').length, count);
  }),
  J('r10-task-badge', 'Two failed tasks and retry/cancel update task rows', async (t) => {
    await t.page.clock.install();
    const jobs = [
      { id: 'job-one', slug: 'fixture', filename: 'one.mp4', status: 'failed' },
      { id: 'job-two', slug: 'fixture', filename: 'two.mp4', status: 'failed' },
    ];
    const m = await login(t, {
      respond: (path, req) => {
        if (path === '/media-jobs') return { json: { jobs } };
        if (path === '/media-jobs/job-one/retry' && req.method() === 'POST') {
          jobs[0].status = 'pending';
          return { json: { ok: true } };
        }
        if (path === '/media-jobs/job-one/cancel' && req.method() === 'POST') {
          jobs[0].status = 'cancelled';
          return { json: { ok: true } };
        }
      },
    });
    await nav(t, 'tasks');
    await waitFor(async () => (await t.page.locator('.media-job-row').count()) === 2);
    const badge = t.page.locator('#nav-task-badge');
    assert(await badge.isVisible());
    assert.equal(await badge.innerText(), '2');
    await t.page.locator('[data-task-filter="active"]').click();
    assert.equal(await badge.innerText(), '2', 'badge counts all failures regardless of filter');
    await t.page.locator('[data-task-filter="all"]').click();
    await shot(t, 'ADR-47-task-badge');
    await t.page.locator('[data-job-id="job-one"][data-job-action="retry"]').click();
    assert.equal((await request(m, 'POST', '/media-jobs/job-one/retry')).body, null);
    await t.page.locator('[data-job-id="job-one"][data-job-action="cancel"]').waitFor();
    assert.equal(await badge.innerText(), '1');
    await t.page.locator('[data-job-id="job-one"][data-job-action="cancel"]').click();
    assert.equal((await request(m, 'POST', '/media-jobs/job-one/cancel')).body, null);
    await t.page.locator('[data-job-id="job-one"][data-job-action="retry"]').waitFor();
    assert.equal(await badge.innerText(), '1');
    jobs[1].status = 'ready';
    await t.page.clock.fastForward(31000);
    await waitFor(async () => !(await badge.isVisible()));
    assert.equal(await badge.textContent(), '0');
    await nav(t, 'posts');
    await t.sleep(300);
    const count = m.requests.filter((r) => r.path === '/media-jobs').length;
    await t.page.clock.fastForward(31000);
    await t.sleep(300);
    assert.equal(m.requests.filter((r) => r.path === '/media-jobs').length, count);
  }),
  J('r10-library-delete', 'Library warns about usage and deletes the selected asset', async (t) => {
    let deleted = false;
    const id = 'ast_0123456789abcdefghjkmnpq';
    const m = await login(t, {
      respond: (path, req) => {
        if (path === `/assets/${id}` && req.method() === 'DELETE') {
          deleted = true;
          return { json: { ok: true } };
        }
        if (path === '/assets' && deleted) return { json: { assets: [], total: 0 } };
      },
    });
    await nav(t, 'library');
    await t.page.locator('.asset-card').first().click();
    await t.page.locator('.modal-overlay .btn-danger').click();
    assert((await t.page.locator('.modal-overlay').last().innerText()).includes('1'));
    const button = await typedConfirmation(t, '1', () => assert(!m.requests.some((r) => r.method === 'DELETE')));
    await shot(t, 'ADR-23-library-confirm');
    await button.click();
    const r = await request(m, 'DELETE', `/assets/${id}`);
    assert.equal(r.body, null);
    assert.equal(new URL(r.url).searchParams.get('force'), '1');
    await waitFor(async () => (await t.page.locator('.asset-card').count()) === 0);
  }),
  J(
    'r11-library-unused-delete',
    'Unused library asset requires the exact filename and supports cancellation',
    async (t) => {
      const id = 'ast_0123456789abcdefghjkmnpq';
      const m = await login(t, {
        respond: (path) =>
          path === '/assets'
            ? {
                json: {
                  assets: [{ id, filename: 'unused.jpg', folder: 'photos', status: 'ready', usage: [] }],
                  total: 1,
                },
              }
            : undefined,
      });
      await nav(t, 'library');
      const openDelete = async () => {
        await t.page.locator('.asset-card').click();
        await t.page.locator('.modal-overlay .btn-danger').click();
      };
      await openDelete();
      const unchanged = () => assert(!m.requests.some((r) => r.method === 'DELETE'));
      await typedConfirmation(t, 'unused.jpg', unchanged);
      await t.page.locator('.modal-overlay .btn-secondary').click();
      unchanged();
      await openDelete();
      await t.page.locator('#modal-confirm-input').fill('unused.jpg');
      await t.page.locator('.modal-overlay .btn-danger').click();
      const r = await request(m, 'DELETE', `/assets/${id}`);
      assert.equal(r.body, null);
      assert.equal(new URL(r.url).searchParams.get('force'), '1');
      assert.equal(m.requests.filter((r) => r.method === 'DELETE').length, 1);
    },
  ),
  J('r10-tag-delete', 'Tag deletion checks count and reloads taxonomy', async (t) => {
    const m = await login(t);
    await nav(t, 'taxonomy');
    assert(!m.requests.some((r) => r.path.startsWith('/taxonomy') && r.method !== 'GET'));
    await t.page.locator('[onclick^="removeTag"]').click();
    const button = await typedConfirmation(t, '1', () => assert(!m.requests.some((r) => r.method === 'DELETE')));
    await button.click();
    const r = await request(m, 'DELETE', '/taxonomy/tag');
    assert.deepEqual(r.body, { name: 'test' });
    await waitFor(() => m.requests.filter((x) => x.path === '/taxonomy' && x.method === 'GET').length >= 2);
    await shot(t, 'ADR-30-tag');
  }),
  J('r10-new-cloud-draft', 'New cloud autosave creates typed payload and restores it', async (t) => {
    let created;
    const m = await login(t, {
      respond: (path, req) => {
        if (path === '/drafts' && req.method() === 'POST') {
          created = {
            ...req.postDataJSON(),
            id: 'drf_0123456789abcdefghjkmnpq',
            revision: 1,
            updatedAt: new Date().toISOString(),
          };
          return { json: created };
        }
        if (path === '/drafts/drf_0123456789abcdefghjkmnpq' && req.method() === 'GET' && created)
          return { json: created };
      },
    });
    await nav(t, 'editor');
    await t.page.locator('#fm-title').fill('Fresh cloud title');
    await t.page.locator('#fm-category').fill('');
    await t.page.locator('#fm-desc').fill('');
    await t.page.locator('#fm-tags').fill('one, two');
    await t.page.locator('#fm-date').fill('2026-08-04');
    await t.page.locator('.fm-text-block').first().fill('Fresh cloud text');
    const r = await request(m, 'POST', '/drafts');
    assert.equal(r.body.title, 'Fresh cloud title');
    assert.equal(r.body.frontMatter.category, null);
    assert.equal(r.body.frontMatter.description, null);
    assert.equal(r.body.frontMatter.date, '2026-08-04T00:00:00.000Z');
    assert.deepEqual(r.body.frontMatter.tags, ['one', 'two']);
    assert.deepEqual(r.body.media, { gallery: [], videos: [], music: [], cover: null });
    await t.sleep(2300);
    assert.equal(m.requests.filter((x) => x.method === 'POST' && x.path === '/drafts').length, 1);
    assert.equal(m.requests.filter((x) => x.method === 'PUT' && x.path.startsWith('/drafts/')).length, 0);
    await t.page.reload();
    await t.page.locator('#cloud-draft-banner').waitFor({ state: 'visible' });
    await shot(t, 'ADR-06-restore-banner');
    await t.page.locator('button[onclick="window.restoreCloudDraft()"]').click();
    assert.equal(await t.page.locator('#fm-title').inputValue(), 'Fresh cloud title');
    assert.equal(await t.page.locator('.fm-text-block').first().inputValue(), 'Fresh cloud text');
  }),
  J('r10-editor-preview', 'Editor preview creates a preview and opens its URL', async (t) => {
    const m = await login(t);
    await nav(t, 'drafts');
    await t.page.locator('[data-open-draft]').click();
    await t.context.route('**/api/preview/preview-token/', (route) =>
      route.fulfill({ contentType: 'text/html', body: 'Fixture preview' }),
    );
    await t.page.locator('button[onclick="window.openPreview()"]').click();
    const r = await request(m, 'POST', '/previews');
    assert.deepEqual(r.body, { draftId: 'drf_0123456789abcdefghjkmnpq' });
    const status = await request(m, 'GET', '/previews/prv_0123456789abcdefghjkmnpq');
    assert.equal(status.body, null);
    await t.page.locator('.toast-action').waitFor();
    await shot(t, 'ADR-21-editor-preview');
    const popup = t.page.waitForEvent('popup');
    await t.page.locator('.toast-action').click();
    const tab = await popup;
    await tab.waitForLoadState('domcontentloaded');
    assert.equal(new URL(tab.url()).pathname, '/api/preview/preview-token/');
    await tab.close();
  }),
  J('r10-publish-failure', 'Publish failure keeps the cloud draft in the editor', async (t) => {
    const m = await login(t, {
      respond: (path, req) =>
        path.endsWith('/publish') && req.method() === 'POST'
          ? { status: 500, json: { error: 'Fixture failure' } }
          : undefined,
    });
    await nav(t, 'drafts');
    await t.page.locator('[data-open-draft]').click();
    await t.page.locator('#fm-title').fill('Retained title');
    await t.page.locator('button[onclick="window.publishDraft()"]').click();
    const r = await request(m, 'POST', '/drafts/drf_0123456789abcdefghjkmnpq/publish');
    assert.equal(r.body, null);
    await t.page.locator('.toast-error').waitFor();
    assert.equal(await t.page.locator('#fm-title').inputValue(), 'Retained title');
    assert((await t.page.evaluate(() => location.hash)).startsWith('#editor'));
    await shot(t, 'ADR-58-publish-failure');
  }),
  J('r10-posts-45', 'Posts show 45 results in chunks and sort locally', async (t) => {
    const posts = Array.from({ length: 45 }, (_, i) => ({
      slug: `post-${String(i).padStart(2, '0')}`,
      title: `Post ${String(i).padStart(2, '0')}`,
      date: '2026-01-01',
      tags: [],
    }));
    const m = await login(t, { respond: (path) => (path === '/posts' ? { json: { posts, total: 45 } } : undefined) });
    await nav(t, 'posts');
    await waitFor(async () => (await t.page.locator('#posts-table tbody tr').count()) === 45);
    assert.equal(await t.page.locator('#posts-load-more button').count(), 0);
    const reads = m.requests.filter((r) => r.path === '/posts').length;
    await t.page.locator('#post-sort').selectOption('title');
    assert((await t.page.locator('#posts-table tbody tr').first().innerText()).includes('Post 00'));
    assert(m.requests.some((r) => r.method === 'GET' && r.path === '/posts' && r.body === null));
    assert.equal(m.requests.filter((r) => r.path === '/posts').length, reads);
    await shot(t, 'ADR-16-posts');
  }),
  J('r10-palette-pages', 'Keyboard opens all thirteen admin pages', async (t) => {
    const m = await login(t);
    const names = [
      'dashboard',
      'posts',
      'editor',
      'build',
      'config',
      'taxonomy',
      'cleanup',
      'tasks',
      'library',
      'drafts',
      'enhance',
      'themes',
      'history',
    ];
    for (let i = 0; i < names.length; i++) {
      await t.page.keyboard.press('Control+k');
      await t.page.locator('#cmd-input').waitFor();
      for (let j = 0; j < i; j++) await t.page.keyboard.press('ArrowDown');
      await t.page.keyboard.press('Enter');
      await waitFor(() => t.page.evaluate((n) => location.hash === '#' + n, names[i]), {
        message: `palette navigates to ${names[i]}`,
      });
      await t.page.locator('#main-content .page-anim').first().waitFor();
      if (names[i] === 'enhance') await shot(t, 'ADR-36-enhance');
    }
    assert(m.requests.some((r) => r.method === 'GET' && r.path === '/taxonomy' && r.body === null));
    await shot(t, 'ADR-12-palette-pages');
  }),
  J('r10-palette-escape', 'Palette clears its query before closing and restores focus', async (t) => {
    await login(t);
    const previous = t.page.locator('#global-search-input');
    await previous.focus();
    await t.page.keyboard.press('Control+k');
    await t.page.locator('#cmd-input').fill('query');
    await shot(t, 'ADR-12-palette-query');
    await t.page.keyboard.press('Escape');
    assert(await t.page.locator('.cmd-overlay').isVisible());
    assert.equal(await t.page.locator('#cmd-input').inputValue(), '');
    assert(await t.page.locator('#cmd-input').evaluate((el) => el === document.activeElement));
    assert((await t.page.locator('.cmd-item').count()) > 0);
    await t.page.keyboard.press('Escape');
    assert.equal(await t.page.locator('.cmd-overlay').count(), 0);
    assert(await previous.evaluate((el) => el === document.activeElement));
    await t.page.keyboard.press('Control+k');
    await t.page.keyboard.press('Escape');
    assert.equal(await t.page.locator('.cmd-overlay').count(), 0);
    assert(await previous.evaluate((el) => el === document.activeElement));
  }),
  J('deep-palette', 'Command palette filters and navigates by keyboard', async (t) => {
    await login(t);
    await t.page.keyboard.press('Control+k');
    await t.page.locator('#cmd-input').fill('设置');
    await waitFor(async () => (await t.page.locator('.cmd-item').count()) > 0);
    assert((await t.page.locator('.cmd-label').first().innerText()).includes('设置'));
    await t.page.keyboard.press('Enter');
    await t.page.locator('[data-config="title"]').waitFor();
    await t.page.keyboard.press('Control+k');
    await t.page.locator('#cmd-input').waitFor();
    await t.page.keyboard.press('Escape');
    assert.equal(await t.page.locator('.cmd-overlay').count(), 0);
  }),

  J('deep-post-delete', 'Post deletion requires the exact slug and supports cancellation', async (t) => {
    let deleted = false;
    const m = await login(t, {
      respond: (path, req) => {
        if (path === '/posts/fixture' && req.method() === 'DELETE') {
          deleted = true;
          return { json: { ok: true } };
        }
        if (path === '/posts' && deleted) return { json: { posts: [], total: 0 } };
      },
    });
    await nav(t, 'posts');
    await t.page.locator('[onclick^="doDeletePost"]').click();
    const unchanged = async () => {
      assert(!m.requests.some((r) => r.method === 'DELETE' && r.path.startsWith('/posts/')));
      assert(await t.page.locator('#posts-table').getByText('Fixture post', { exact: true }).isVisible());
    };
    await typedConfirmation(t, 'fixture', unchanged);
    await shot(t, 'AD-17-delete-dialog');
    await t.page.locator('.modal-overlay .btn-secondary').click();
    await unchanged();
    await t.page.locator('[onclick^="doDeletePost"]').click();
    await t.page.locator('#modal-confirm-input').fill('fixture');
    await t.page.locator('.modal-overlay .btn-danger').click();
    const r = await request(m, 'DELETE', '/posts/fixture');
    assert.equal(r.body, null);
    await t.page.locator('#main-content .empty-state').waitFor();
    assert.equal(await t.page.locator('[onclick^="doDeletePost"]').count(), 0);
    assert.equal(m.requests.filter((r) => r.method === 'DELETE' && r.path === '/posts/fixture').length, 1);
  }),
  J('deep-build', 'Build trigger cancels or confirms before sending a request', async (t) => {
    const m = await login(t);
    await nav(t, 'build');
    await t.page.locator('[data-build-trigger]').first().click();
    await t.page.locator('.modal-overlay').waitFor();
    assert(!m.requests.some((r) => r.method === 'POST' && r.path === '/build'));
    await t.page.locator('.modal-overlay .btn-secondary').click();
    assert(!m.requests.some((r) => r.method === 'POST' && r.path === '/build'));
    assert(await t.page.locator('[data-build-trigger]').first().isEnabled());
    await t.page.locator('[data-build-trigger]').first().click();
    await t.page.locator('.modal-overlay .btn-primary').click();
    const r = await request(m, 'POST', '/build');
    assert.equal(r.body, null);
    assert.equal(m.requests.filter((r) => r.method === 'POST' && r.path === '/build').length, 1);
    assert.equal(await t.page.locator('.modal-overlay').count(), 0);
    await t.page.locator('.toast-success').waitFor();
    await shot(t, 'AD-39-build');
  }),

  J(
    'deep-draft-preview',
    'Draft list preview uses the selected draft and opens its ready URL in a new tab',
    async (t) => {
      const m = await login(t);
      await nav(t, 'drafts');
      // Context routing also intercepts the new tab's first navigation.
      await t.context.route('**/api/preview/preview-token/', (route) =>
        route.fulfill({ contentType: 'text/html', body: 'Fixture preview' }),
      );
      await t.page.locator('[data-preview-draft]').click();
      const r = await request(m, 'POST', '/previews');
      assert.deepEqual(r.body, { draftId: 'drf_0123456789abcdefghjkmnpq' });
      await request(m, 'GET', '/previews/prv_0123456789abcdefghjkmnpq');
      const popup = t.page.waitForEvent('popup');
      await t.page.locator('.toast-action').click();
      const tab = await popup;
      await tab.waitForLoadState('domcontentloaded');
      assert.equal(new URL(tab.url()).pathname, '/api/preview/preview-token/');
      assert.equal(await tab.evaluate(() => window.opener), null);
      assert.equal(await t.page.evaluate(() => location.hash), '#drafts');
      assert.equal(await t.page.locator('.draft-row').count(), 1);
      assert(!m.requests.some((r) => r.method === 'PUT' || r.method === 'DELETE'));
      await tab.close();
    },
  ),
];
