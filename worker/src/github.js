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

// ====== Contents API ======

export async function listPosts(c) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/content/posts`, { headers: headers(c) });
  if (!resp.ok) throw new Error(`GitHub listPosts: ${resp.status}`);
  const dirs = (await resp.json()).filter(f => f.type === 'dir');
  return Promise.all(dirs.map(async d => {
    try {
      const mdResp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/content/posts/${d.name}/index.md`, { headers: headers(c) });
      if (!mdResp.ok) return { slug: d.name, title: d.name };
      const md = await mdResp.json();
      const content = atob(md.content);
      const fm = parseFrontMatter(content);
      return { slug: d.name, title: fm.title || d.name, category: fm.category, tags: fm.tags || [], date: fm.date, description: fm.description };
    } catch { return { slug: d.name, title: d.name }; }
  }));
}

export async function getPost(c, slug) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/content/posts/${slug}/index.md`, { headers: headers(c) });
  if (!resp.ok) return null;
  const md = await resp.json();
  const content = atob(md.content);
  const fm = parseFrontMatter(content);
  const body = content.replace(/^---[\s\S]*?---\n?/, '').trim();
  return { slug, frontMatter: fm, body, sha: md.sha };
}

export async function createOrUpdatePost(c, slug, frontMatter, body, message) {
  const existing = await getPost(c, slug);
  const yaml = Object.entries(frontMatter)
    .map(([k, v]) => Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`)
    .join('\n');
  const content = `---\n${yaml}\n---\n\n${body || ''}`;
  const endpoint = `${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/content/posts/${slug}/index.md`;
  const payload = { message: message || `Update ${slug}`, content: btoa(content) };
  if (existing?.sha) payload.sha = existing.sha;
  const resp = await fetch(endpoint, {
    method: 'PUT',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`GitHub createPost(${slug}): ${resp.status}`);
  return resp.json();
}

export async function deletePost(c, slug, message) {
  // Get all files in post directory
  const dirResp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/content/posts/${slug}`, { headers: headers(c) });
  if (!dirResp.ok) throw new Error(`Post not found: ${slug}`);
  const files = await dirResp.json();
  const list = Array.isArray(files) ? files : [files];
  // Delete each file
  for (const f of list) {
    await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/${f.path}`, {
      method: 'DELETE',
      headers: { ...headers(c), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message || `Delete ${slug}`, sha: f.sha }),
    });
  }
  return { deleted: true, count: list.length };
}

// ====== Actions Dispatch ======

export async function dispatchBuild(c) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'publish' }),
  });
  if (!resp.ok) throw new Error(`dispatch: ${resp.status}`);
}

export async function getLatestRun(c) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/runs?per_page=1&event=pull_request&event=push`, { headers: headers(c) });
  // Filter for push events
  const allRuns = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/runs?per_page=3`, { headers: headers(c) });
  if (!allRuns.ok) return null;
  const data = await allRuns.json();
  return data.workflow_runs?.[0] || null;
}

// ====== Config ======

export async function getConfig(c) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/mosaic.config.json`, { headers: headers(c) });
  if (!resp.ok) return {};
  const file = await resp.json();
  return JSON.parse(atob(file.content));
}

export async function updateConfig(c, config, message) {
  const existing = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/mosaic.config.json`, { headers: headers(c) });
  if (!existing.ok) throw new Error('Config not found');
  const file = await existing.json();
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/mosaic.config.json`, {
    method: 'PUT',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message || 'Update config', content: btoa(JSON.stringify(config, null, 2)), sha: file.sha }),
  });
  if (!resp.ok) throw new Error(`updateConfig: ${resp.status}`);
  return resp.json();
}

// ====== Helpers ======

function parseFrontMatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  match[1].split('\n').forEach(line => {
    const m = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (!m) return;
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
    }
    fm[m[1]] = val;
  });
  return fm;
}
