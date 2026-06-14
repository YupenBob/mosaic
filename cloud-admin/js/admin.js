/**
 * Mosaic Cloud Admin — Main Application
 *
 * Hash-based SPA router with simple component rendering.
 * Pages: dashboard, posts, editor, media, build, config, taxonomy, trash, deploy
 */

import { auth, posts as postsApi, media as mediaApi, upload, build, stats, config, taxonomy, trash, disk, health } from '../src/api.js';
import { getToken, setToken } from '../src/api.js';

// ── State ──────────────────────────────────
const state = {
  currentPage: 'dashboard',
  posts: [],
  categories: [],
  tags: [],
  currentSlug: null,
};

// ── Router ─────────────────────────────────
function navigate(hash) {
  const page = hash.replace('#', '') || 'dashboard';
  state.currentPage = page;
  updateNav(page);
  renderPage(page);
}

function updateNav(page) {
  document.querySelectorAll('.nav-item[data-page]').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page);
  });
}

window.addEventListener('hashchange', () => navigate(location.hash));
window.addEventListener('mosaic:auth-expired', showLogin);

// ── Auth ───────────────────────────────────
function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  setToken(null);
}

async function handleLogin() {
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');

  if (!password) {
    errorEl.textContent = 'Please enter a password';
    errorEl.style.display = 'block';
    return;
  }

  try {
    const { token } = await auth.login(password);
    setToken(token);
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    navigate(location.hash || '#dashboard');
    document.getElementById('login-error').style.display = 'none';
  } catch (err) {
    errorEl.textContent = 'Login failed: ' + err.message;
    errorEl.style.display = 'block';
  }
}

document.getElementById('login-btn').addEventListener('click', handleLogin);
document.getElementById('login-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin();
});
document.getElementById('logout-btn').addEventListener('click', showLogin);

// ── Page Renderers ─────────────────────────
const pages = {};

pages.dashboard = async () => {
  try {
    const [dashboardData, healthData, recentFilesData] = await Promise.all([
      stats.dashboard(), health.check(), disk.recentFiles()
    ]);

    return `
      <h1>Dashboard</h1>
      <div class="stats-grid">
        <div class="stat-card"><span class="stat-num">${dashboardData.posts || 0}</span><span class="stat-label">Posts</span></div>
        <div class="stat-card"><span class="stat-num">${dashboardData.categories || 0}</span><span class="stat-label">Categories</span></div>
        <div class="stat-card"><span class="stat-num">${dashboardData.tags || 0}</span><span class="stat-label">Tags</span></div>
        <div class="stat-card"><span class="stat-num">${dashboardData.diskUsage ? (dashboardData.diskUsage.total / 1024 / 1024).toFixed(0) : 0} MB</span><span class="stat-label">Media Storage</span></div>
      </div>
      <div style="margin-top:12px;font-size:13px;color:${healthData.ok ? '#2ecc71' : '#e74c3c'}">
        ${healthData.ok ? '<i class="ri-check-line"></i> All good' : '<i class="ri-error-warning-line"></i> ' + healthData.count + ' issues'}
      </div>
      <h2 style="margin-top:24px">Recent Files</h2>
      <div style="font-size:13px">${(recentFilesData || []).slice(0, 10).map(f =>
        '<div style="padding:4px 0;border-bottom:1px solid var(--color-border-light)">' +
        '<span style="font-family:var(--font-mono)">' + f.path + '</span> ' +
        '<span style="color:var(--color-text-tertiary)">' + new Date(f.mtime).toLocaleString() + '</span></div>'
      ).join('') || '<p style="color:var(--color-text-tertiary)">No recent files</p>'}</div>
    `;
  } catch (err) {
    return `<h1>Dashboard</h1><p class="error">Failed to load: ${err.message}</p>`;
  }
};

pages.posts = async () => {
  try {
    const postsData = await postsApi.list();
    state.posts = postsData;

    return `
      <div class="page-header">
        <h1>Posts</h1>
        <div style="display:flex;gap:8px">
          <button class="btn-primary" onclick="location.hash='editor'"><i class="ri-add-line"></i> New</button>
          <button class="btn-secondary" onclick="batchDelete()"><i class="ri-delete-bin-line"></i> Delete Selected</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <input type="text" id="post-search" placeholder="Search posts..." style="flex:1;min-width:160px;padding:8px;border:1px solid var(--color-border);border-radius:6px" />
      </div>
      <table class="data-table">
        <thead><tr><th><input type="checkbox" id="select-all" /></th><th>Title</th><th>Category</th><th>Tags</th><th>Media</th><th>Date</th><th></th></tr></thead>
        <tbody>
        ${(postsData || []).map(p => `
          <tr>
            <td><input type="checkbox" class="post-check" value="${p.slug}" /></td>
            <td><a href="#editor&slug=${p.slug}" style="font-weight:500">${p.title || p.slug}</a></td>
            <td>${p.category || ''}</td>
            <td>${(p.tags || []).map(t => '#' + t).join(' ')}</td>
            <td>${p.photoCount ? '<i class="ri-image-line"></i> ' + p.photoCount : ''} ${p.videoCount ? '<i class="ri-video-line"></i> ' + p.videoCount : ''}</td>
            <td style="font-size:12px;color:var(--color-text-tertiary)">${p.date ? p.date.split('T')[0] : ''}</td>
            <td>
              <button onclick="location.hash='editor&slug=${p.slug}'" class="btn-sm"><i class="ri-edit-line"></i></button>
              <button onclick="deletePost('${p.slug}')" class="btn-sm" style="color:#e74c3c"><i class="ri-delete-bin-line"></i></button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    return `<h1>Posts</h1><p class="error">Failed to load posts: ${err.message}</p>`;
  }
};

pages.editor = async () => {
  const params = new URLSearchParams(location.hash.split('&').slice(1).join('&'));
  const slug = params.get('slug') || '';
  state.currentSlug = slug;

  let post = { slug: '', frontMatter: {}, body: '' };
  if (slug) {
    try { post = await postsApi.get(slug); } catch {}
  }

  return `
    <div class="page-header">
      <h1>${slug ? 'Edit: ' + (post.frontMatter?.title || slug) : 'New Post'}</h1>
      <div>
        <button class="btn-primary" onclick="saveCurrentPost()"><i class="ri-save-line"></i> Save</button>
      </div>
    </div>
    <div class="editor-layout">
      <div class="editor-fields">
        <label>Slug <input type="text" id="fm-slug" value="${slug}" ${slug ? 'readonly' : ''} /></label>
        <label>Title <input type="text" id="fm-title" value="${post.frontMatter?.title || ''}" /></label>
        <label>Date <input type="date" id="fm-date" value="${post.frontMatter?.date || new Date().toISOString().split('T')[0]}" /></label>
        <label>Category <input type="text" id="fm-category" value="${post.frontMatter?.category || ''}" /></label>
        <label>Tags <input type="text" id="fm-tags" value="${(post.frontMatter?.tags || []).join(', ')}" /></label>
        <label>Description <textarea id="fm-desc" rows="2">${post.frontMatter?.description || ''}</textarea></label>
        <label>Layout <select id="fm-layout">
          <option value="default" ${post.frontMatter?.layout === 'default' ? 'selected' : ''}>default</option>
          <option value="video-first" ${post.frontMatter?.layout === 'video-first' ? 'selected' : ''}>video-first</option>
          <option value="gallery-first" ${post.frontMatter?.layout === 'gallery-first' ? 'selected' : ''}>gallery-first</option>
          <option value="music-first" ${post.frontMatter?.layout === 'music-first' ? 'selected' : ''}>music-first</option>
        </select></label>
        <label>Cover <input type="text" id="fm-cover" value="${post.frontMatter?.cover || ''}" placeholder="cover.jpg or video:0 or photo:0" /></label>
      </div>
      <div class="editor-body">
        <textarea id="fm-body" style="width:100%;height:400px;font-family:var(--font-mono);font-size:14px;padding:12px;border:1px solid var(--color-border);border-radius:6px">${post.body || ''}</textarea>
      </div>
    </div>
    <div class="editor-media" style="margin-top:20px">
      <h3>Upload Media</h3>
      <div class="upload-zone" id="upload-zone">
        <i class="ri-upload-cloud-2-line" style="font-size:32px;color:#4361ee"></i>
        <p>Drag & drop files here, or click to select</p>
        <input type="file" id="editor-media-input" multiple accept="image/*,video/*,audio/*" style="display:none" />
      </div>
      <div id="upload-progress" style="margin-top:8px"></div>
    </div>
  `;
};

pages.build = async () => {
  try {
    const buildStatus = await build.status();
    const buildHistory = await build.history();

    return `
      <h1>Build</h1>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button class="btn-primary" onclick="triggerBuild()"><i class="ri-play-fill"></i> Build & Deploy</button>
      </div>
      <div class="build-status-card" style="padding:16px;background:var(--color-surface);border:1px solid var(--color-border-light);border-radius:8px;margin-bottom:16px">
        <strong>Status:</strong> ${buildStatus?.status || 'unknown'}
        ${buildStatus?.conclusion ? ' • ' + buildStatus.conclusion : ''}
        ${buildStatus?.htmlUrl ? '<br><a href="' + buildStatus.htmlUrl + '" target="_blank" style="color:var(--color-accent);font-size:13px">View on GitHub <i class="ri-external-link-line"></i></a>' : ''}
      </div>
      <h3>Recent Builds</h3>
      <table class="data-table">
        <thead><tr><th>#</th><th>Status</th><th>Conclusion</th><th>Time</th></tr></thead>
        <tbody>
        ${(buildHistory?.runs || []).map(r => `
          <tr>
            <td>#${r.runNumber}</td>
            <td>${r.status}</td>
            <td>${r.conclusion || '-'}</td>
            <td style="font-size:12px">${new Date(r.createdAt).toLocaleString()}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    return `<h1>Build</h1><p class="error">Failed: ${err.message}</p>`;
  }
};

pages.config = async () => {
  try {
    const cfg = await config.get();

    return `
      <div class="page-header"><h1>Site Configuration</h1><button class="btn-primary" onclick="saveConfig()"><i class="ri-save-line"></i> Save</button></div>
      <div class="config-form">
        ${renderConfigField('title', cfg.title, 'Site Title')}
        ${renderConfigField('subtitle', cfg.subtitle, 'Subtitle')}
        ${renderConfigField('description', cfg.description, 'Description', 'textarea')}
        ${renderConfigField('url', cfg.url, 'Site URL')}
        ${renderConfigField('language', cfg.language, 'Language')}
        ${renderConfigField('pageSize', cfg.pageSize, 'Posts Per Page', 'number')}
        ${renderConfigField('gallerySingleThreshold', cfg.gallerySingleThreshold, 'Gallery Single Threshold', 'number')}
        <h3 style="margin-top:20px">Giscus Comments</h3>
        ${renderConfigField('giscus.repo', cfg.giscus?.repo || '', 'GitHub Repo')}
        ${renderConfigField('giscus.category', cfg.giscus?.category || 'Announcements', 'Category')}
      </div>
    `;
  } catch (err) {
    return `<h1>Config</h1><p class="error">${err.message}</p>`;
  }
};

pages.taxonomy = async () => {
  try {
    const tax = await taxonomy.get();
    return `
      <h1>Categories & Tags</h1>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
        <div>
          <h2>Categories</h2>
          ${(tax.categories || []).map(c => `
            <div style="padding:8px 0;border-bottom:1px solid var(--color-border-light);display:flex;justify-content:space-between">
              <span>${c.name} <small style="color:var(--color-text-tertiary)">(${c.count})</small></span>
              <button class="btn-sm" onclick="renameCategory('${c.name}')"><i class="ri-edit-line"></i></button>
            </div>`).join('')}
        </div>
        <div>
          <h2>Tags</h2>
          ${(tax.tags || []).map(t => `
            <div style="padding:8px 0;border-bottom:1px solid var(--color-border-light);display:flex;justify-content:space-between">
              <span>#${t.name} <small style="color:var(--color-text-tertiary)">(${t.count})</small></span>
              <button class="btn-sm" onclick="renameTag('${t.name}')"><i class="ri-edit-line"></i></button>
            </div>`).join('')}
        </div>
      </div>
    `;
  } catch (err) {
    return `<h1>Taxonomy</h1><p class="error">${err.message}</p>`;
  }
};

pages.trash = async () => {
  try {
    const items = await trash.list();
    return `
      <div class="page-header"><h1>Trash</h1><button class="btn-secondary" onclick="emptyTrash()"><i class="ri-delete-bin-line"></i> Empty All</button></div>
      ${(items || []).map(t => `
        <div style="padding:8px;border-bottom:1px solid var(--color-border-light);display:flex;justify-content:space-between;align-items:center">
          <span>${t.title || t.dir} <small style="color:var(--color-text-tertiary)">${t.mtime ? new Date(t.mtime).toLocaleString() : ''}</small></span>
          <div>
            <button class="btn-sm" onclick="restoreFromTrash('${t.dir}')"><i class="ri-arrow-go-back-line"></i> Restore</button>
            <button class="btn-sm" style="color:#e74c3c" onclick="permanentDelete('${t.dir}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </div>`).join('') || '<p style="color:var(--color-text-tertiary)">Trash is empty</p>'}
    `;
  } catch (err) {
    return `<h1>Trash</h1><p class="error">${err.message}</p>`;
  }
};

pages.deploy = () => `
  <h1>Deploy</h1>
  <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
    <button class="btn-primary" onclick="triggerDeploy('gh-pages')"><i class="ri-github-fill"></i> GitHub Pages</button>
    <button class="btn-primary" onclick="triggerDeploy('cf')"><i class="ri-cloud-fill"></i> Cloudflare Pages</button>
    <button class="btn-primary" onclick="triggerDeploy('vercel')"><i class="ri-vercel-fill"></i> Vercel</button>
  </div>
  <pre id="deploy-log" style="background:#1d1d1f;color:#e5e5ea;padding:16px;border-radius:8px;font-size:13px;min-height:200px;white-space:pre-wrap"></pre>
`;

pages.media = async () => {
  const params = new URLSearchParams(location.hash.split('&').slice(1).join('&'));
  const slug = params.get('slug') || '';

  if (!slug) return '<h1>Media</h1><p>Select a post to manage its media.</p>';

  try {
    const mediaData = await mediaApi.list(slug);
    return `
      <h1>Media — ${slug}</h1>
      <h2>Photos</h2>
      <div class="media-grid">${renderMediaThumbs(mediaData.photos, slug, 'photos')}</div>
      <h2 style="margin-top:16px">Videos</h2>
      <div class="media-grid">${renderMediaThumbs(mediaData.videos, slug, 'videos')}</div>
    `;
  } catch (err) {
    return `<h1>Media</h1><p class="error">${err.message}</p>`;
  }
};

// ── Helpers ─────────────────────────────────
function renderConfigField(key, value, label, type = 'text') {
  const isTextarea = type === 'textarea';
  return `<label style="display:block;margin-bottom:12px">
    <span style="font-size:13px;color:var(--color-text-secondary)">${label}</span>
    ${isTextarea
      ? `<textarea data-config="${key}" style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--color-border);border-radius:6px" rows="3">${value || ''}</textarea>`
      : `<input type="${type}" data-config="${key}" value="${value || ''}" style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--color-border);border-radius:6px" />`}
  </label>`;
}

function renderMediaThumbs(files, slug, type) {
  if (!files || files.length === 0) return '<p style="color:var(--color-text-tertiary)">No media</p>';
  return files.map(f => `
    <div style="position:relative;display:inline-block;margin:4px">
      ${type === 'photos' ? `<img src="${f.url}" alt="${f.name}" style="width:100px;height:100px;object-fit:cover;border-radius:4px" />` : ''}
      <div style="font-size:11px">${f.name}</div>
      <button onclick="deleteMedia('${slug}', '${f.name}', '${type}')" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.6);color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer">×</button>
    </div>`).join('');
}

// ── Render page ─────────────────────────────
async function renderPage(page) {
  const main = document.getElementById('main-content');
  if (!main) return;

  main.innerHTML = '<div style="text-align:center;padding:40px"><i class="ri-loader-4-line" style="font-size:24px;animation:spin 1s linear infinite"></i></div>';

  const renderer = pages[page] || (() => '<h1>404</h1><p>Page not found</p>');
  try {
    const html = await renderer();
    main.innerHTML = html;
  } catch (err) {
    main.innerHTML = `<h1>Error</h1><p>${err.message}</p>`;
  }
}

// ── Global Actions (attached to window) ─────
window.saveCurrentPost = async () => {
  const slug = document.getElementById('fm-slug').value;
  const frontMatter = {
    title: document.getElementById('fm-title').value,
    date: document.getElementById('fm-date').value,
    category: document.getElementById('fm-category').value,
    tags: document.getElementById('fm-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    description: document.getElementById('fm-desc').value,
    layout: document.getElementById('fm-layout').value,
    cover: document.getElementById('fm-cover').value,
  };
  const body = document.getElementById('fm-body').value;

  try {
    if (state.currentSlug) {
      await postsApi.update(state.currentSlug, { frontMatter, body });
    } else {
      await postsApi.create({ slug, frontMatter, body });
    }
    alert('Saved!');
    location.hash = 'posts';
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
};

window.triggerBuild = async () => {
  try {
    await build.trigger();
    alert('Build triggered! Check status below.');
    location.hash = 'build';
  } catch (err) {
    alert('Build trigger failed: ' + err.message);
  }
};

window.saveConfig = async () => {
  const data = {};
  document.querySelectorAll('[data-config]').forEach(el => {
    const key = el.dataset.config;
    const keys = key.split('.');
    let obj = data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = el.value;
  });
  try {
    await config.update(data);
    alert('Config saved!');
  } catch (err) {
    alert('Save config failed: ' + err.message);
  }
};

window.deletePost = async (slug) => {
  if (!confirm('Move "' + slug + '" to trash?')) return;
  try {
    await postsApi.delete(slug);
    location.reload();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
};

window.deleteMedia = async (slug, file, type) => {
  if (!confirm('Delete ' + file + '?')) return;
  try {
    await mediaApi.delete(slug, file, type);
    location.reload();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
};

window.restoreFromTrash = async (dir) => {
  try {
    await trash.restore(dir);
    location.reload();
  } catch (err) {
    alert('Restore failed: ' + err.message);
  }
};

window.permanentDelete = async (dir) => {
  if (!confirm('Permanently delete "' + dir + '"?')) return;
  try {
    await trash.permanentDelete(dir);
    location.reload();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
};

window.triggerDeploy = async (target) => {
  const log = document.getElementById('deploy-log');
  try {
    log.textContent = 'Triggering deploy to ' + target + '...';
    // Deploy triggers a build via Worker → GitHub dispatch
    await build.trigger();
    log.textContent += '\nDeploy triggered! The site will be live shortly.';
  } catch (err) {
    log.textContent += '\nError: ' + err.message;
  }
};

window.renameCategory = async (oldName) => {
  const newName = prompt('Rename category "' + oldName + '" to:', oldName);
  if (!newName || newName === oldName) return;
  try {
    await taxonomy.renameCategory(oldName, newName);
    alert('Renamed ' + oldName + ' → ' + newName);
    location.reload();
  } catch (err) {
    alert('Rename failed: ' + err.message);
  }
};

window.renameTag = async (oldName) => {
  const newName = prompt('Rename tag "' + oldName + '" to:', oldName);
  if (!newName || newName === oldName) return;
  try {
    await taxonomy.renameTag(oldName, newName);
    alert('Renamed ' + oldName + ' → ' + newName);
    location.reload();
  } catch (err) {
    alert('Rename failed: ' + err.message);
  }
};

// ── Init ────────────────────────────────────
(function init() {
  const token = getToken();
  if (token) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    navigate(location.hash || '#dashboard');
  }
})();

// Spin animation
const style = document.createElement('style');
style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
document.head.appendChild(style);
