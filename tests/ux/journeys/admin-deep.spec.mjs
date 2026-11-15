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
    await shot(t, 'AD-21-published');
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
