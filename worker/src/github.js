/**
 * GitHub API wrapper — used by Worker to read/write repo contents and trigger workflows.
 */
const GITHUB_API = 'https://api.github.com';

function headers(c) {
  return {
    Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Mosaic-Worker/0.8',
  };
}

// ====== In-Memory Cache ======
let _postsCache = null;
let _postsTime = 0;
let _configCache = null;
let _configTime = 0;
const CACHE_MS = { posts: 60000, config: 120000 };

export function bustCache() {
  _postsCache = null;
  _configCache = null;
}

// ====== Dirty State (R2 + memory) ======
const DIRTY_KEY = 'site-data/dirty.json';
let _dirtyState = null; // { count: number, last: ISO string }

export async function isDirty(env) {
  if (_dirtyState) return _dirtyState;
  try {
    const obj = await env.MEDIA.get(DIRTY_KEY);
    if (obj) _dirtyState = JSON.parse(await obj.text());
  } catch {}
  return _dirtyState;
}

export async function markDirty(env) {
  const now = new Date().toISOString();
  if (_dirtyState) {
    _dirtyState.count++;
    _dirtyState.last = now;
  } else _dirtyState = { count: 1, last: now };
  try {
    await env.MEDIA.put(DIRTY_KEY, JSON.stringify(_dirtyState), { httpMetadata: { contentType: 'application/json' } });
  } catch (e) {
    console.error('markDirty: R2 write failed (memory state kept for this session)', e.message);
  }
}

export async function clearDirty(env) {
  _dirtyState = null;
  try {
    await env.MEDIA.delete(DIRTY_KEY);
  } catch (e) {
    // If the delete fails, the next isDirty() read would resurrect the stale
    // R2 flag — retry once and surface the error instead of swallowing it.
    console.error('clearDirty: R2 delete failed, retrying', e.message);
    try {
      await env.MEDIA.delete(DIRTY_KEY);
    } catch (e2) {
      console.error('clearDirty: retry failed — banner may persist until next build', e2.message);
    }
  }
}

// ====== Contents API ======

async function listPostsUncached(c) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/content/posts`, { headers: headers(c) });
  if (!resp.ok) throw new Error(`GitHub listPosts: ${resp.status}`);
  const dirs = (await resp.json()).filter((f) => f.type === 'dir');
  return Promise.all(
    dirs.map(async (d) => {
      try {
        const mdResp = await fetch(
          `${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/content/posts/${d.name}/index.md`,
          { headers: headers(c) },
        );
        if (!mdResp.ok) return { slug: d.name, title: d.name };
        const md = await mdResp.json();
        const content = decodeBase64(md.content);
        const fm = parseFrontMatter(content);
        return {
          slug: d.name,
          title: fm.title || d.name,
          category: fm.category,
          tags: fm.tags || [],
          date: fm.date,
          description: fm.description,
          cover: fm.cover || '',
        };
      } catch {
        return { slug: d.name, title: d.name, cover: '' };
      }
    }),
  );
}

async function listPostsFromR2(c) {
  try {
    const obj = await c.env.MEDIA.get('site-data/posts.json');
    if (!obj) return null;
    const posts = JSON.parse(await obj.text());
    if (!Array.isArray(posts)) return null;
    return posts.map((p) => ({
      slug: p.slug,
      title: p.title || p.slug,
      category: p.category,
      tags: p.tags || [],
      date: p.date,
      description: p.description,
      cover: p.cover || '',
    }));
  } catch {
    return null;
  }
}

export async function listPosts(c) {
  if (_postsCache && Date.now() - _postsTime < CACHE_MS.posts) return _postsCache;
  let fresh = null;
  // Prefer the build-time R2 cache (fast, no GitHub rate-limit cost). Fall
  // back to GitHub when there are unbuilt changes (dirty) or the cache is missing.
  try {
    const dirty = await isDirty(c.env);
    if (!dirty || !dirty.count) fresh = await listPostsFromR2(c);
  } catch {}
  if (!fresh) fresh = await listPostsUncached(c);
  _postsCache = fresh;
  _postsTime = Date.now();
  return fresh;
}

export async function getPost(c, slug) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/content/posts/${slug}/index.md`, {
    headers: headers(c),
  });
  if (!resp.ok) return null;
  const md = await resp.json();
  const content = decodeBase64(md.content);
  const fm = parseFrontMatter(content);
  const body = content.replace(/^---[\s\S]*?---\n?/, '').trim();
  return { slug, frontMatter: fm, body, sha: md.sha };
}

export async function createOrUpdatePost(c, slug, frontMatter, body, message) {
  const existing = await getPost(c, slug);
  const yaml = Object.entries(frontMatter)
    .map(([k, v]) => (Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`))
    .join('\n');
  const content = `---\n${yaml}\n---\n\n${body || ''}`;
  const endpoint = `${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/content/posts/${slug}/index.md`;
  const payload = { message: message || `Update ${slug}`, content: encodeBase64(content) };
  if (existing?.sha) payload.sha = existing.sha;
  const resp = await fetch(endpoint, {
    method: 'PUT',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`GitHub createPost(${slug}): ${resp.status}`);
  bustCache();
  return resp.json();
}

async function deleteDir(c, dirPath, message) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/${dirPath}`, { headers: headers(c) });
  if (!resp.ok) return 0;
  const items = await resp.json();
  let count = 0;
  for (const item of Array.isArray(items) ? items : [items]) {
    if (item.type === 'dir') {
      count += await deleteDir(c, item.path, message);
    } else {
      const delResp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/${item.path}`, {
        method: 'DELETE',
        headers: { ...headers(c), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sha: item.sha }),
      });
      if (delResp.ok) count++;
    }
  }
  return count;
}

export async function deletePost(c, slug, message) {
  const msg = message || `Delete ${slug}`;
  const count = await deleteDir(c, `content/posts/${slug}`, msg);
  bustCache();
  return { deleted: true, count };
}

// ====== Actions Dispatch ======

export async function dispatchBuild(c) {
  // Prefer workflow_dispatch (no git history noise). Requires GITHUB_TOKEN with actions:write.
  const dispatchResp = await fetch(
    `${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/workflows/pipeline.yml/dispatches`,
    {
      method: 'POST',
      headers: { ...headers(c), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    },
  );
  if (dispatchResp.ok || dispatchResp.status === 204) {
    return { method: 'workflow_dispatch', status: dispatchResp.status };
  }
  if (dispatchResp.status === 401 || dispatchResp.status === 403 || dispatchResp.status === 404) {
    // Fallback: commit .build-trigger to kick off the push-based workflow
    // (token without actions:write).
    const ts = new Date().toISOString();
    const path = '.build-trigger';
    const content = `${ts}\n`;
    let sha = '';
    try {
      const existing = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/${path}`, {
        headers: headers(c),
      });
      if (existing.ok) {
        const f = await existing.json();
        sha = f.sha;
      }
    } catch {}
    const payload = { message: `Build trigger ${ts}`, content: encodeBase64(content) };
    if (sha) payload.sha = sha;
    const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/${path}`, {
      method: 'PUT',
      headers: { ...headers(c), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Build trigger failed: ${resp.status} — ${body.slice(0, 200)}`);
    }
    return { method: 'push_trigger', status: resp.status };
  }
  const body = await dispatchResp.text().catch(() => '');
  throw new Error(`workflow_dispatch failed: ${dispatchResp.status} — ${body.slice(0, 200)}`);
}

export async function getLatestRun(c) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/workflows/pipeline.yml/runs?per_page=1`, {
    headers: headers(c),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const run = data.workflow_runs?.[0];
  if (!run) return null;
  const repo = c.env.GITHUB_REPO;
  const result = {
    id: run.id,
    runNumber: run.run_number,
    status: run.status,
    conclusion: run.conclusion,
    displayTitle: run.display_title,
    headBranch: run.head_branch,
    headSha: run.head_sha?.slice(0, 7),
    headShaFull: run.head_sha || '',
    commitMessage: run.head_commit?.message?.split('\n')[0] || '',
    htmlUrl: run.html_url,
    commitUrl: run.head_sha ? `https://github.com/${repo}/commit/${run.head_sha}` : '',
    repo: `https://github.com/${repo}`,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    event: run.event,
  };

  // Fetch job steps for running or terminal builds (full pipeline timeline)
  if (run.status === 'in_progress' || run.conclusion === 'success' || run.conclusion === 'failure') {
    try {
      const jobsResp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/runs/${run.id}/jobs`, {
        headers: headers(c),
      });
      if (jobsResp.ok) {
        const jobsData = await jobsResp.json();
        const steps = [];
        let jobUrl = '';
        for (const job of jobsData.jobs || []) {
          if (!jobUrl && job.html_url) jobUrl = job.html_url;
          for (const step of job.steps || []) {
            steps.push({
              name: step.name,
              status: step.status,
              conclusion: step.conclusion || '',
              number: step.number,
              startedAt: step.started_at || '',
              completedAt: step.completed_at || '',
            });
          }
        }
        result.steps = steps;
        result.totalSteps = steps.length;
        result.jobUrl = jobUrl;
        const failed = steps.find((s) => s.conclusion === 'failure');
        if (failed) {
          result.failedStep = {
            name: failed.name,
            number: failed.number,
            logUrl: jobUrl ? `${jobUrl}#step:${failed.number}:1` : '',
          };
        }
      }
    } catch {}
  }

  return result;
}

export async function getRunHistory(c) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/workflows/pipeline.yml/runs?per_page=10`, {
    headers: headers(c),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  const repo = c.env.GITHUB_REPO;
  return (data.workflow_runs || []).map((run) => ({
    id: run.id,
    runNumber: run.run_number,
    status: run.status,
    conclusion: run.conclusion,
    displayTitle: run.display_title,
    headBranch: run.head_branch,
    headSha: run.head_sha?.slice(0, 7),
    headShaFull: run.head_sha || '',
    commitMessage: run.head_commit?.message?.split('\n')[0] || '',
    htmlUrl: run.html_url,
    commitUrl: run.head_sha ? `https://github.com/${repo}/commit/${run.head_sha}` : '',
    repo: `https://github.com/${repo}`,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    event: run.event,
  }));
}

// ====== Config ======

export async function getConfig(c) {
  if (_configCache && Date.now() - _configTime < CACHE_MS.config) return _configCache;
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/mosaic.config.json`, {
    headers: headers(c),
  });
  if (!resp.ok) return {};
  const file = await resp.json();
  const fresh = JSON.parse(decodeBase64(file.content));
  _configCache = fresh;
  _configTime = Date.now();
  return fresh;
}

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base;
  if (!base || typeof base !== 'object' || !patch || typeof patch !== 'object') return patch ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

export async function updateConfig(c, config, message) {
  const existing = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/mosaic.config.json`, {
    headers: headers(c),
  });
  if (!existing.ok) throw new Error('Config not found');
  const file = await existing.json();
  const current = JSON.parse(decodeBase64(file.content));
  // Deep merge: the admin form only sends edited fields; never drop nested sections
  const merged = deepMerge(current, config);
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/mosaic.config.json`, {
    method: 'PUT',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || 'Update config',
      content: encodeBase64(JSON.stringify(merged, null, 2)),
      sha: file.sha,
    }),
  });
  if (!resp.ok) throw new Error(`updateConfig: ${resp.status}`);
  bustCache();
  return resp.json();
}

async function fetchRawFile(c, repoPath) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/${repoPath}`, { headers: headers(c) });
  if (!resp.ok) return null;
  const file = await resp.json();
  return { sha: file.sha, content: decodeBase64(file.content) };
}

async function putRawFile(c, repoPath, content, sha, message) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/${repoPath}`, {
    method: 'PUT',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: encodeBase64(content), sha }),
  });
  return resp.ok;
}

export async function renameCategory(c, oldName, newName, message) {
  const posts = await listPosts(c);
  let renamed = 0;
  for (const p of posts) {
    if ((p.category || '') !== oldName) continue;
    const file = await fetchRawFile(c, `content/posts/${p.slug}/index.md`);
    if (!file) continue;
    const next = file.content.replace(/^category:.*$/m, `category: ${newName}`);
    if (next === file.content) continue;
    if (
      await putRawFile(
        c,
        `content/posts/${p.slug}/index.md`,
        next,
        file.sha,
        message || `Rename category ${oldName} to ${newName}`,
      )
    )
      renamed++;
  }
  bustCache();
  return renamed;
}

export async function renameTag(c, oldName, newName, message) {
  const posts = await listPosts(c);
  let renamed = 0;
  for (const p of posts) {
    const tags = (p.tags || []).map((t) => String(t));
    if (!tags.includes(oldName)) continue;
    const file = await fetchRawFile(c, `content/posts/${p.slug}/index.md`);
    if (!file) continue;
    const newTags = tags.map((t) => (t === oldName ? newName : t));
    const next = file.content.replace(/^tags:.*$/m, `tags: [${newTags.join(', ')}]`);
    if (next === file.content) continue;
    if (
      await putRawFile(
        c,
        `content/posts/${p.slug}/index.md`,
        next,
        file.sha,
        message || `Rename tag ${oldName} to ${newName}`,
      )
    )
      renamed++;
  }
  bustCache();
  return renamed;
}

/**
 * Remove a category from every post that uses it (posts themselves are kept).
 * Returns the number of posts that were rewritten.
 */
export async function removeCategory(c, name, message) {
  const posts = await listPosts(c);
  let affected = 0;
  for (const p of posts) {
    if ((p.category || '') !== name) continue;
    const file = await fetchRawFile(c, `content/posts/${p.slug}/index.md`);
    if (!file) continue;
    const next = file.content.replace(/^category:.*$/m, '');
    if (next === file.content) continue;
    if (await putRawFile(c, `content/posts/${p.slug}/index.md`, next, file.sha, message || `Remove category ${name}`))
      affected++;
  }
  bustCache();
  return affected;
}

/**
 * Remove a tag from every post that uses it (posts themselves are kept).
 * Returns the number of posts that were rewritten.
 */
export async function removeTag(c, name, message) {
  const posts = await listPosts(c);
  let affected = 0;
  for (const p of posts) {
    const tags = (p.tags || []).map(String);
    if (!tags.includes(name)) continue;
    const file = await fetchRawFile(c, `content/posts/${p.slug}/index.md`);
    if (!file) continue;
    const newTags = tags.filter((tag) => tag !== name);
    const next = file.content.replace(/^tags:.*$/m, newTags.length ? `tags: [${newTags.join(', ')}]` : '');
    if (next === file.content) continue;
    if (await putRawFile(c, `content/posts/${p.slug}/index.md`, next, file.sha, message || `Remove tag ${name}`))
      affected++;
  }
  bustCache();
  return affected;
}

// ====== UTF-8 safe base64 ======

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ====== Helpers ======

function parseFrontMatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  match[1].split('\n').forEach((line) => {
    const m = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (!m) return;
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
    }
    fm[m[1]] = val;
  });
  return fm;
}
