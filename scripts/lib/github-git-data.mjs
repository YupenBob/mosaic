/**
 * Minimal GitHub Git Data API client: commit a batch of files as ONE commit
 * without cloning anything locally.
 *
 * The migration CLI used to rewrite posts one `PUT /contents` at a time, which
 * produced one commit (and one CI run) per post. This client builds the whole
 * change as `blob → tree → commit → ref`, so a hundred posts are a single
 * atomic commit.
 *
 * Conflict safety: the commit parent is the ref SHA read before any blob is
 * created, `expectedBaseSha` is asserted against that head, and the ref update
 * is never forced. A concurrent push therefore fails the migration instead of
 * silently overwriting someone else's commit.
 */

const API_BASE = 'https://api.github.com';

function conflict(message) {
  return Object.assign(new Error(message), { code: 'CONFLICT' });
}

/**
 * @param {{path:string, content:string}[]} files
 * @returns {{path:string, content:string}[]}
 */
export function validateFiles(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('At least one file is required');
  const seen = new Set();
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string')
      throw new Error('Each file needs a string path and content');
    const { path } = file;
    if (
      !path ||
      path.startsWith('/') ||
      path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    )
      throw new Error(`Unsafe file path: ${path}`);
    if (seen.has(path)) throw new Error(`Duplicate file path: ${path}`);
    seen.add(path);
  }
  return files;
}

/**
 * @param {object} options
 * @param {string} options.repo - `owner/repo`
 * @param {string} options.token - GitHub token with `contents: write`
 * @param {string} options.branch - target branch
 * @param {Function} [options.fetch] - injectable fetch (tests)
 * @param {string} [options.baseUrl]
 */
export function createGitDataClient({ repo, token, branch, fetch: fetchImpl = fetch, baseUrl = API_BASE } = {}) {
  if (!repo) throw new Error('GITHUB_REPO is required');
  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (!branch) throw new Error('SITE_BRANCH is required');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Mosaic-Media-V2-Migration',
    'Content-Type': 'application/json',
  };
  const refPath = `${baseUrl}/repos/${repo}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const repoPath = `${baseUrl}/repos/${repo}/git`;

  async function call(method, url, body) {
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      const error = new Error(`GitHub ${method} ${url.replace(baseUrl, '')}: ${response.status} ${text}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  return {
    /** Current head of the target branch. */
    async readHead() {
      const ref = await call('GET', refPath);
      return { sha: ref.object?.sha };
    },

    /**
     * Create one commit containing every file.
     * @param {{files:{path:string, content:string}[], message:string, expectedBaseSha?:string, author?:object}} options
     * @returns {Promise<{sha:string, url:string, files:number}>}
     */
    async commitFiles({ files, message, expectedBaseSha, author } = {}) {
      validateFiles(files);
      if (!message) throw new Error('Commit message is required');
      const head = await this.readHead();
      if (!head.sha) throw new Error('Cannot resolve the current branch head');
      if (expectedBaseSha && expectedBaseSha !== head.sha)
        throw conflict(
          `Migration base moved: expected ${expectedBaseSha.slice(0, 7)}, branch head is ${head.sha.slice(0, 7)}`,
        );
      const baseCommit = await call('GET', `${repoPath}/commits/${head.sha}`);
      const baseTree = baseCommit.tree?.sha;
      if (!baseTree) throw new Error('Cannot resolve the base tree');

      // Blobs are independent: bounded concurrency keeps the API happy.
      const blobs = new Array(files.length);
      let next = 0;
      const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
        while (next < files.length) {
          const index = next++;
          blobs[index] = await call('POST', `${repoPath}/blobs`, {
            content: files[index].content,
            encoding: 'utf-8',
          });
        }
      });
      await Promise.all(workers);

      const tree = await call('POST', `${repoPath}/trees`, {
        base_tree: baseTree,
        tree: files.map((file, index) => ({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blobs[index].sha,
        })),
      });
      const commit = await call('POST', `${repoPath}/commits`, {
        message,
        tree: tree.sha,
        parents: [head.sha],
        ...(author ? { author, committer: author } : {}),
      });
      try {
        await call('PATCH', refPath, { sha: commit.sha, force: false });
      } catch (error) {
        if (error.status === 422 || error.status === 409)
          throw conflict(`Ref update rejected (branch moved during migration): ${error.message}`);
        throw error;
      }
      return { sha: commit.sha, url: commit.html_url || '', files: files.length };
    },
  };
}
