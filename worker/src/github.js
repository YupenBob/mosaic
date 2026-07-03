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
      const content = decodeBase64(md.content);
      const fm = parseFrontMatter(content);
      return { slug: d.name, title: fm.title || d.name, category: fm.category, tags: fm.tags || [], date: fm.date, description: fm.description, cover: fm.cover || '' };
    } catch { return { slug: d.name, title: d.name, cover: '' }; }
  }));
}

export async function getPost(c, slug) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/content/posts/${slug}/index.md`, { headers: headers(c) });
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
    .map(([k, v]) => Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`)
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
  return resp.json();
}

async function deleteDir(c, dirPath, message) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/${dirPath}`, { headers: headers(c) });
  if (!resp.ok) return 0;
  const items = await resp.json();
  let count = 0;
  for (const item of (Array.isArray(items) ? items : [items])) {
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
  return { deleted: true, count };
}

// ====== Actions Dispatch ======

export async function dispatchBuild(c) {
  // Commit a trigger file to kick off push-based workflow (most reliable, no extra permissions)
  const ts = new Date().toISOString();
  const path = '.build-trigger';
  const content = `${ts}\n`;

  // Get existing file (if any) to get its SHA
  let sha = '';
  try {
    const existing = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/${path}`, { headers: headers(c) });
    if (existing.ok) {
      const f = await existing.json();
      sha = f.sha;
    }
  } catch {}

  const payload = {
    message: `Build trigger ${ts}`,
    content: encodeBase64(content),
  };
  if (sha) payload.sha = sha;

  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Build trigger commit failed: ${resp.status} — ${body.slice(0, 200)}`);
  }

  return { method: 'push_trigger', status: resp.status };
}

export async function getLatestRun(c) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/workflows/pipeline.yml/runs?per_page=1`, { headers: headers(c) });
  if (!resp.ok) return null;
  const data = await resp.json();
  const run = data.workflow_runs?.[0];
  if (!run) return null;
  const result = {
    id: run.id,
    runNumber: run.run_number,
    status: run.status,
    conclusion: run.conclusion,
    displayTitle: run.display_title,
    headBranch: run.head_branch,
    headSha: run.head_sha?.slice(0, 7),
    commitMessage: run.head_commit?.message?.split('\n')[0] || '',
    htmlUrl: run.html_url,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    event: run.event,
  };

  // Fetch job steps for in-progress builds
  if (run.status === 'in_progress') {
    try {
      const jobsResp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/runs/${run.id}/jobs`, { headers: headers(c) });
      if (jobsResp.ok) {
        const jobsData = await jobsResp.json();
        const steps = [];
        for (const job of (jobsData.jobs || [])) {
          for (const step of (job.steps || [])) {
            if (step.status === 'completed') continue; // skip finished steps
            steps.push({ name: step.name, status: step.status, number: step.number });
          }
        }
        result.steps = steps;
        result.totalSteps = Math.max(...(jobsData.jobs || []).flatMap(j => (j.steps || []).map(s => s.number)), 0);
      }
    } catch {}
  }

  return result;
}

export async function getRunHistory(c) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/actions/workflows/pipeline.yml/runs?per_page=10`, { headers: headers(c) });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.workflow_runs || []).map(run => ({
    id: run.id,
    runNumber: run.run_number,
    status: run.status,
    conclusion: run.conclusion,
    displayTitle: run.display_title,
    headBranch: run.head_branch,
    headSha: run.head_sha?.slice(0, 7),
    commitMessage: run.head_commit?.message?.split('\n')[0] || '',
    htmlUrl: run.html_url,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    event: run.event,
  }));
}

// ====== Config ======

export async function getConfig(c) {
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/mosaic.config.json`, { headers: headers(c) });
  if (!resp.ok) return {};
  const file = await resp.json();
  return JSON.parse(decodeBase64(file.content));
}

export async function updateConfig(c, config, message) {
  const existing = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/mosaic.config.json`, { headers: headers(c) });
  if (!existing.ok) throw new Error('Config not found');
  const file = await existing.json();
  const resp = await fetch(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/mosaic.config.json`, {
    method: 'PUT',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message || 'Update config', content: encodeBase64(JSON.stringify(config, null, 2)), sha: file.sha }),
  });
  if (!resp.ok) throw new Error(`updateConfig: ${resp.status}`);
  return resp.json();
}

// ====== UTF-8 safe base64 ======

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
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
