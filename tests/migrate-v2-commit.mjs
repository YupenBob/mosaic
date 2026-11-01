/**
 * Media v2 migration commit path: one Git commit for every rewritten post and
 * copy skipping for already-migrated R2 objects. The GitHub Git Data API is
 * faked in memory, so no credentials or network are involved.
 */
import assert from 'node:assert/strict';
import { applyV2Migration, uniqueCopies } from '../scripts/media/apply-v2.mjs';
import { createGitDataClient, validateFiles } from '../scripts/lib/github-git-data.mjs';

// ── Fake GitHub Git Data API ──
function createFakeGitHub({ head = 'a'.repeat(40), rejectRefUpdate = false } = {}) {
  const state = {
    head,
    blobs: new Map(),
    trees: new Map(),
    commits: new Map([[head, { sha: head, tree: 't'.repeat(40), message: 'base', parents: [] }]]),
    treeEntries: [],
    calls: [],
    blobCalls: 0,
    commitCalls: 0,
    refUpdates: [],
  };
  let counter = 0;
  const id = (prefix) => `${prefix}${String(++counter).padStart(39, '0')}`;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const { method = 'GET' } = init;
    const pathname = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    state.calls.push(`${method} ${pathname.replace('/repos/o/r/git', '')}`);
    if (method === 'GET' && pathname.endsWith('/git/ref/heads/main')) return json({ object: { sha: state.head } });
    if (method === 'GET' && /\/git\/commits\//.test(pathname)) {
      const sha = pathname.split('/').pop();
      const commit = state.commits.get(sha);
      return commit ? json({ ...commit, tree: { sha: commit.tree } }) : json({ message: 'Not Found' }, 404);
    }
    if (method === 'POST' && pathname.endsWith('/git/blobs')) {
      state.blobCalls++;
      const sha = id('b');
      state.blobs.set(sha, body);
      return json({ sha });
    }
    if (method === 'POST' && pathname.endsWith('/git/trees')) {
      state.treeEntries = body.tree;
      const tree = { sha: id('t'), base_tree: body.base_tree, entries: body.tree };
      state.trees.set(tree.sha, tree);
      return json({ sha: tree.sha });
    }
    if (method === 'POST' && pathname.endsWith('/git/commits')) {
      state.commitCalls++;
      const sha = id('c');
      state.commits.set(sha, { ...body, sha });
      state.created = sha;
      return json({ sha, html_url: `https://github.com/o/r/commit/${sha}` });
    }
    if (method === 'PATCH' && pathname.endsWith('/git/ref/heads/main')) {
      if (rejectRefUpdate) return json({ message: 'Update is not a fast forward' }, 422);
      state.refUpdates.push(body);
      state.head = body.sha;
      return json({ object: { sha: body.sha } });
    }
    return json({ message: `Unhandled ${method} ${pathname}` }, 500);
  };
  return { state, fetchImpl };
}

const client = (fake) =>
  createGitDataClient({
    repo: 'o/r',
    token: 'test-token',
    branch: 'main',
    fetch: fake.fetchImpl,
    baseUrl: 'https://api.github.com',
  });

// ── One commit for many files ──
{
  const fake = createFakeGitHub();
  const files = ['a', 'b', 'c'].map((slug) => ({
    path: `content/posts/${slug}/index.md`,
    content: `---\ntitle: ${slug}\nmedia:\n  gallery: []\n---\nbody ${slug}\n`,
  }));
  const result = await client(fake).commitFiles({
    files,
    message: 'Migrate media to v2: 3 posts [skip ci]',
    expectedBaseSha: 'a'.repeat(40),
  });
  assert.equal(result.files, 3);
  assert.equal(result.sha, fake.state.created);
  assert.match(result.url, /github\.com\/o\/r\/commit\//);
  assert.equal(fake.state.commitCalls, 1, 'exactly one commit for all posts');
  assert.equal(fake.state.blobCalls, 3, 'one blob per file');
  assert.deepEqual(
    [...fake.state.blobs.values()].map((blob) => blob.encoding),
    ['utf-8', 'utf-8', 'utf-8'],
  );
  const commit = fake.state.commits.get(fake.state.created);
  assert.deepEqual(commit.parents, ['a'.repeat(40)], 'commit parent is the captured base');
  assert.match(commit.message, /\[skip ci\]/, 'migration commit must skip CI');
  assert.equal(fake.state.trees.get(commit.tree).base_tree, 't'.repeat(40), 'tree extends the base tree');
  assert.deepEqual(
    fake.state.treeEntries.map((entry) => entry.path),
    files.map((file) => file.path),
  );
  assert.deepEqual(fake.state.refUpdates, [{ sha: fake.state.created, force: false }], 'ref fast-forward only');
  // blob → tree → commit → ref happens once, in order.
  assert.deepEqual(fake.state.calls.slice(0, 2), ['GET /ref/heads/main', `GET /commits/${'a'.repeat(40)}`]);
  assert.deepEqual(fake.state.calls.slice(-3), ['POST /trees', 'POST /commits', 'PATCH /ref/heads/main']);
}

// ── A moved base fails before any write ──
{
  const fake = createFakeGitHub({ head: 'b'.repeat(40) });
  await assert.rejects(
    () =>
      client(fake).commitFiles({
        files: [{ path: 'content/posts/a/index.md', content: 'x' }],
        message: 'Migrate media to v2: 1 posts [skip ci]',
        expectedBaseSha: 'a'.repeat(40),
      }),
    /base moved/,
  );
  assert.equal(fake.state.blobCalls, 0, 'conflict detected before blobs are written');
  assert.equal(fake.state.commitCalls, 0);
}

// ── A rejected ref update surfaces as a conflict ──
{
  const fake = createFakeGitHub({ rejectRefUpdate: true });
  await assert.rejects(
    () =>
      client(fake).commitFiles({
        files: [{ path: 'content/posts/a/index.md', content: 'x' }],
        message: 'Migrate media to v2: 1 posts [skip ci]',
        expectedBaseSha: 'a'.repeat(40),
      }),
    /Ref update rejected/,
  );
}

// ── Unsafe paths never reach the API ──
assert.throws(() => validateFiles([{ path: '../secrets.md', content: 'x' }]), /Unsafe file path/);
assert.throws(() => validateFiles([]), /At least one file/);
assert.throws(
  () =>
    validateFiles([
      { path: 'content/posts/a/index.md', content: 'x' },
      { path: 'content/posts/a/index.md', content: 'y' },
    ]),
  /Duplicate file path/,
);

// ── Re-running the migration skips existing R2 destinations ──
{
  const plan = {
    assets: [],
    copies: [
      { from: 'originals/a/x.jpg', to: 'originals/assets/a/x.jpg' },
      { from: 'originals/b/y.jpg', to: 'originals/assets/b/y.jpg' },
    ],
    posts: [{ slug: 'a', media: { gallery: [], videos: [], music: [], cover: null } }],
    counts: { assets: 0, copies: 2, posts: 1 },
  };
  const events = [];
  const result = await applyV2Migration({
    plan,
    head: async (to) => {
      events.push(['head', to]);
      return to === 'originals/assets/a/x.jpg';
    },
    copy: async (from, to) => events.push(['copy', from, to]),
    importAssets: async () => events.push(['import']),
    writeMarker: async (value) => events.push(['marker', value.skippedCopies]),
  });
  assert.deepEqual(result, { assets: 0, copies: 1, posts: 1, skippedCopies: 1 });
  assert.deepEqual(
    events.filter((event) => event[0] === 'copy'),
    [['copy', 'originals/b/y.jpg', 'originals/assets/b/y.jpg']],
    'only missing targets are copied',
  );
  assert.deepEqual(events.at(-1), ['marker', 1], 'skipped copies are recorded in the marker');
  assert.equal(uniqueCopies(plan).length, 2);
}

console.log('Migrate v2 commit: single commit, conflict guards, path safety and copy skipping passed');
