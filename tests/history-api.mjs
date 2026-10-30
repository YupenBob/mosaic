/**
 * Git history: list, detail and restore through mocked GitHub Contents.
 */
import assert from 'node:assert/strict';
import { createRuntime } from './helpers/runtime.mjs';
import { getHistoryCommit, listHistory, restoreHistory } from '../worker/src/services/history.js';

const runtime = createRuntime();
const context = { env: runtime.env };
const sha = 'a'.repeat(40);
const realFetch = globalThis.fetch;
const calls = [];

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  calls.push({ path, method: init.method || 'GET', body: init.body });
  if (path.endsWith('/commits')) {
    return json([
      {
        sha,
        html_url: 'https://github.com/x/y/commit/' + sha,
        commit: { message: 'Edit post\n\nbody', author: { name: 'Yupen', date: '2026-10-30T00:00:00Z' } },
      },
    ]);
  }
  if (path.endsWith('/commits/' + sha)) {
    return json({
      sha,
      html_url: 'https://github.com/x/y/commit/' + sha,
      commit: { message: 'Edit post', author: { name: 'Yupen', date: '2026-10-30T00:00:00Z' } },
      files: [
        { filename: 'content/posts/a/index.md', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@' },
        { filename: 'content/posts/b/index.md', status: 'removed', additions: 0, deletions: 3, patch: '' },
      ],
    });
  }
  if (path.includes('/contents/content/posts/a/index.md')) {
    if (init.method === 'PUT') return json({ commit: { sha: 'restore-a' } });
    const atCommit = new URL(url).searchParams.get('ref') === sha;
    return json({
      sha: 'current-a',
      content: Buffer.from(atCommit ? 'old content' : 'new content').toString('base64'),
    });
  }
  if (path.includes('/contents/content/posts/b/index.md')) {
    if (init.method === 'DELETE') return json({ commit: { sha: 'restore-b' } });
    return json({ sha: 'current-b', content: Buffer.from('deleted content').toString('base64') });
  }
  return json({ message: 'Not found' }, 404);
};

try {
  const list = await listHistory(context);
  assert.equal(list.length, 1);
  assert.equal(list[0].shortSha, 'aaaaaaa');
  assert.equal(list[0].message, 'Edit post');
  const detail = await getHistoryCommit(context, sha);
  assert.equal(detail.files.length, 2);
  const restored = await restoreHistory(context, sha);
  assert.equal(restored.ok, true);
  assert.deepEqual(
    restored.files.map((file) => file.status),
    ['restored', 'deleted'],
  );
  const put = calls.find((call) => call.method === 'PUT' && call.path.includes('content/posts/a'));
  assert.ok(put, 'modified file is restored with PUT');
  assert.ok(calls.some((call) => call.method === 'DELETE' && call.path.includes('content/posts/b')));
  await assert.rejects(() => getHistoryCommit(context, 'not-a-sha'), /Invalid commit sha/);
  console.log('History API: list, detail, restore and validation passed');
} finally {
  globalThis.fetch = realFetch;
}
