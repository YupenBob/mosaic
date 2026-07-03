/**
 * Mosaic Cloud Admin — clean SPA, 6 pages
 */
const API = window.__API_BASE__ || '/api';
let token = localStorage.getItem('mosaic_token') || '';
let state = { page: 'dashboard', posts: [] };

// ── Helpers ──
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

async function api(path, opts = {}) {
  const h = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) h['Authorization'] = 'Bearer ' + token;
  const r = await fetch(API + path, { ...opts, headers: h });
  if (r.status === 401) { token = ''; localStorage.removeItem('mosaic_token'); showLogin(); throw new Error('Unauthorized'); }
  if (!r.ok) { const b = await r.json().catch(()=>({})); throw new Error(b.error || `HTTP ${r.status}`); }
  return r.json();
}

// ── Auth ──
function showLogin() { $('#login-screen').style.display = 'flex'; $('#app').style.display = 'none'; $('#loading').style.display = 'none'; token = ''; localStorage.removeItem('mosaic_token'); }

window.login = async () => {
  const pw = $('#login-pw').value;
  try {
    const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
    token = r.token; localStorage.setItem('mosaic_token', token);
    $('#login-screen').style.display = 'none'; $('#app').style.display = 'flex';
    $('#login-error').style.display = 'none';
    navigate(location.hash || '#dashboard');
  } catch (e) { $('#login-error').style.display = 'block'; $('#login-error').textContent = e.message; }
};

window.logout = () => showLogin();

// ── Router ──
function navigate(hash) {
  const [page, ...rest] = hash.replace('#','').split('&');
  state.page = page || 'dashboard';
  state.params = Object.fromEntries(new URLSearchParams(rest.join('&')));
  $$('.nav-item[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === state.page));
  render(page);
}

async function render(page) {
  const m = $('#main-content');
  m.innerHTML = '<div style="text-align:center;padding:40px;color:var(--color-text-tertiary)"><i class="ri-loader-4-line" style="font-size:24px;animation:spin 1s linear infinite"></i></div>';
  try {
    const fn = pages[page] || (() => '<h1>Page not found</h1>');
    const html = await fn();
    if (state.page !== page) return;
    m.innerHTML = html;
    if (pages[page + 'Mount']) pages[page + 'Mount']();
  } catch (e) { m.innerHTML = `<h1>Error</h1><p style="color:var(--color-danger)">${esc(e.message)}</p>`; }
}

window.addEventListener('hashchange', () => navigate(location.hash));
window.addEventListener('mosaic:auth-expired', showLogin);

// ── Toast ──
function toast(msg, type = 'info') {
  let c = $('.toast-container'); if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c); }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${msg}</span>`;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }, 4000);
}

// ── Pages ──
const pages = {};

pages.dashboard = async () => {
  const [stats, health, posts] = await Promise.all([
    api('/stats').catch(() => ({ posts: 0, categories: 0, tags: 0 })),
    api('/health').catch(() => ({ status: 'unknown' })),
    api('/posts').catch(() => ({ posts: [], total: 0 })),
  ]);
  const list = posts.posts || posts;
  const lastBuild = list.length ? list[0].date?.slice(0, 10) || '—' : '—';
  return `
    <h1>Dashboard</h1>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-card-icon" style="background:rgba(67,97,238,.1);color:#4361ee"><i class="ri-article-line"></i></div><div><div class="stat-num">${stats.posts||0}</div><div class="stat-label">Posts</div></div></div>
      <div class="stat-card"><div class="stat-card-icon" style="background:rgba(46,204,113,.1);color:#2ecc71"><i class="ri-price-tag-3-line"></i></div><div><div class="stat-num">${stats.categories||0}</div><div class="stat-label">Categories</div></div></div>
      <div class="stat-card"><div class="stat-card-icon" style="background:rgba(240,165,0,.1);color:#f0a500"><i class="ri-hashtag"></i></div><div><div class="stat-num">${stats.tags||0}</div><div class="stat-label">Tags</div></div></div>
      <div class="stat-card"><div class="stat-card-icon" style="background:rgba(155,89,182,.1);color:#9b59b6"><i class="ri-hard-drive-2-line"></i></div><div><div class="stat-num">${lastBuild}</div><div class="stat-label">Last Build</div></div></div>
    </div>
    <div class="health-bar">
      <div class="health-item"><span class="health-dot" style="background:${health.status==='ok'?'#2ecc71':'#e74c3c'}"></span> API ${health.status}</div>
    </div>
    <h2>Recent Posts</h2>
    <table class="data-table">
      <tr><th>Post</th><th>Category</th><th>Date</th></tr>
      ${list.slice(0,8).map(p => `<tr><td><a href="#editor&slug=${esc(p.slug)}">${esc(p.title||p.slug)}</a></td><td>${esc(p.category||'')}</td><td>${(p.date||'').slice(0,10)}</td></tr>`).join('')}
    </table>
  `;
};

pages.posts = async () => {
  const result = await api('/posts');
  const list = result.posts || result;
  state.posts = list;
  return `
    <div class="page-header"><h1>Posts (${list.length})</h1><button class="btn-primary" onclick="location.hash='editor'"><i class="ri-add-line"></i> New</button></div>
    <input type="text" id="post-search" placeholder="Search..." style="width:100%;max-width:320px;padding:8px;border:1px solid var(--color-border);border-radius:6px;margin-bottom:12px" oninput="filterPosts(this.value)" />
    <table class="data-table">
      <tr><th>Title</th><th>Category</th><th>Tags</th><th>Date</th><th></th></tr>
      ${list.map(p => `<tr data-search="${esc(p.title||'')} ${esc(p.category||'')} ${(p.tags||[]).join(' ')}">
        <td><a href="#editor&slug=${esc(p.slug)}">${esc(p.title||p.slug)}</a></td>
        <td>${esc(p.category||'')}</td>
        <td>${(p.tags||[]).map(t=>'#'+esc(t)).join(' ')}</td>
        <td>${(p.date||'').slice(0,10)}</td>
        <td>
          <button onclick="location.hash='editor&slug=${esc(p.slug)}'" class="btn-sm"><i class="ri-edit-line"></i></button>
          <button onclick="deletePost('${esc(p.slug)}')" class="btn-sm" style="color:#e74c3c"><i class="ri-delete-bin-line"></i></button>
        </td>
      </tr>`).join('')}
    </table>
  `;
};

window.filterPosts = (q) => {
  const s = q.toLowerCase();
  $$('#main-content tbody tr').forEach(tr => tr.style.display = s && !(tr.dataset.search||'').toLowerCase().includes(s) ? 'none' : '');
};

window.deletePost = async (slug) => {
  if (!confirm('Delete "' + slug + '"?')) return;
  await api('/posts/' + slug, { method: 'DELETE' });
  toast('Deleted ' + slug, 'success');
  navigate('#posts');
};

pages.editor = async () => {
  const slug = state.params.slug || '';
  let post = { slug: '', frontMatter: {}, body: '' };
  if (slug) { try { post = await api('/posts/' + slug); } catch {} }
  const fm = post.frontMatter || {};
  return `
    <div class="page-header"><h1>${slug ? 'Edit' : 'New Post'}</h1><button class="btn-primary" onclick="savePost()"><i class="ri-save-line"></i> Save</button></div>
    <div class="editor-layout">
      <div class="editor-fields">
        <label>Slug <input type="text" id="fm-slug" value="${esc(slug)}" ${slug?'readonly':''} /></label>
        <label>Title <input type="text" id="fm-title" value="${esc(fm.title||'')}" /></label>
        <label>Date <input type="date" id="fm-date" value="${fm.date||new Date().toISOString().slice(0,10)}" /></label>
        <label>Category <input type="text" id="fm-category" value="${esc(fm.category||'')}" placeholder="e.g. photography/nature" /></label>
        <label>Tags <input type="text" id="fm-tags" value="${(fm.tags||[]).join(', ')}" /></label>
        <label>Description <textarea id="fm-desc" rows="2">${esc(fm.description||'')}</textarea></label>
        <label>Layout <select id="fm-layout"><option value="default" ${fm.layout==='default'?'selected':''}>default</option><option value="video-first" ${fm.layout==='video-first'?'selected':''}>video-first</option><option value="gallery-first" ${fm.layout==='gallery-first'?'selected':''}>gallery-first</option></select></label>
        <label>Cover <input type="text" id="fm-cover" value="${esc(fm.cover||'')}" placeholder="cover.jpg" /></label>
      </div>
      <div class="editor-body">
        <textarea id="fm-body" style="width:100%;height:400px;font-family:var(--font-mono);font-size:14px;padding:12px;border:1px solid var(--color-border);border-radius:6px">${esc(post.body||'')}</textarea>
      </div>
    </div>
    <div style="margin-top:20px">
      <h3>Upload Media</h3>
      <div class="upload-zone" id="upload-zone"><i class="ri-upload-cloud-2-line" style="font-size:32px;color:#4361ee"></i><p>Drop files or click to browse</p><input type="file" id="file-input" multiple accept="image/*,video/*,audio/*" style="display:none" /></div>
      <div id="upload-progress" style="margin-top:12px"></div>
      <div id="existing-media" style="margin-top:16px"></div>
    </div>
  `;
};

pages.editorMount = () => {
  setupUpload();
  if (state.params.slug) loadExistingMedia(state.params.slug);
};

window.savePost = async () => {
  const slug = $('#fm-slug').value;
  const fm = {
    title: $('#fm-title').value,
    date: $('#fm-date').value,
    category: $('#fm-category').value,
    tags: $('#fm-tags').value.split(',').map(s=>s.trim()).filter(Boolean),
    description: $('#fm-desc').value,
    layout: $('#fm-layout').value,
    cover: $('#fm-cover').value,
  };
  const body = $('#fm-body').value;
  try {
    const result = await api('/posts', { method: 'POST', body: JSON.stringify({ slug, frontMatter: fm, body, message: `Update ${slug}` }) });
    toast(`Saved: ${result.slug}`, 'success');
    location.hash = 'posts';
  } catch (e) { toast(e.message, 'error'); }
};

pages.build = async () => {
  let status = { status: 'loading' }, history = { runs: [] };
  try { [status, history] = await Promise.all([api('/build/status').catch(()=>({status:'unknown'})), api('/build/history').catch(()=>({runs:[]}))]); } catch {}
  const runs = history.runs || [];
  const latest = status.status !== 'unknown' ? status : runs[0];
  const c = status.status === 'in_progress' ? '#f0a500' : status.conclusion === 'success' ? '#2ecc71' : status.conclusion === 'failure' ? '#e74c3c' : '#86868b';
  const label = status.status === 'in_progress' ? 'Running' : status.conclusion || status.status || '—';

  return `
    <div class="page-header"><h1>Build & Deploy</h1><button class="btn-primary" id="trigger-build" onclick="triggerBuild()"><i class="ri-play-fill"></i> Build & Deploy</button></div>
    <div class="build-status-card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <span style="width:10px;height:10px;border-radius:50%;background:${c};${status.status==='in_progress'?'animation:pulse 1.5s infinite':''}"></span>
        <strong>Status:</strong> <span style="color:${c}">${label}</span>
        ${status.runNumber ? '<span style="font-family:var(--font-mono);color:var(--color-text-tertiary)">#'+status.runNumber+'</span>' : ''}
      </div>
      ${status.htmlUrl ? `<a href="${status.htmlUrl}" target="_blank" style="color:var(--color-accent);font-size:13px">View on GitHub <i class="ri-external-link-line"></i></a>` : '<span style="color:var(--color-text-tertiary)">No builds yet</span>'}
    </div>
    ${runs.length ? `<h3>History</h3><div>${runs.map(r => {
      const sc = r.conclusion === 'success' ? '#2ecc71' : r.conclusion === 'failure' ? '#e74c3c' : '#86868b';
      return `<div class="build-list-item" style="margin-bottom:2px">
        <span style="font-family:var(--font-mono);font-weight:600;min-width:40px">#${r.runNumber}</span>
        <span class="build-badge" style="background:${sc}22;color:${sc}">${r.conclusion||r.status}</span>
        <span style="flex:1;color:var(--color-text-secondary);font-size:12px">${esc(r.commitMessage||'').slice(0,60)}</span>
        <span style="font-size:11px;color:var(--color-text-tertiary)">${r.createdAt ? new Date(r.createdAt).toLocaleDateString('zh-CN') : ''}</span>
        ${r.htmlUrl ? `<a href="${r.htmlUrl}" target="_blank" class="btn-sm">Details <i class="ri-external-link-line"></i></a>` : ''}
      </div>`;
    }).join('')}</div>` : ''}
  `;
};

pages.buildMount = () => {
  let timer;
  const poll = async () => {
    try {
      const s = await api('/build/status');
      if (s.status !== 'in_progress' && s.status !== 'queued') { clearInterval(timer); $('#build-page')?.updateStatus(s); }
    } catch {}
  };
  timer = setInterval(poll, 5000);
};

window.triggerBuild = async () => {
  const btn = $('#trigger-build');
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Triggering...';
  btn.disabled = true;
  try {
    const r = await api('/build', { method: 'POST' });
    toast(`Build triggered via ${r.method||'push'}!`, 'success');
    navigate('#build');
  } catch (e) {
    if (e.message.includes('already in progress')) toast('Build already running', 'info');
    else toast('Failed: ' + e.message, 'error');
  }
  btn.innerHTML = orig;
  btn.disabled = false;
};

pages.config = async () => {
  let cfg = {};
  try { cfg = await api('/config'); } catch {}
  const fields = [
    ['title','Site Title'],['subtitle','Subtitle'],['description','Description','textarea'],
    ['url','Site URL'],['language','Language'],['pageSize','Posts Per Page','number'],
    ['gallerySingleThreshold','Gallery Threshold','number'],
  ];
  return `
    <div class="page-header"><h1>Configuration</h1><button class="btn-primary" onclick="saveConfig()"><i class="ri-save-line"></i> Save</button></div>
    <div class="config-form">
      ${fields.map(([k,l,t])=>{
        const v = cfg[k]||'';
        return `<label>${l}${t==='textarea' ? `<textarea data-config="${k}" rows="2">${esc(v)}</textarea>` : `<input type="${t||'text'}" data-config="${k}" value="${esc(v)}" />`}</label>`;
      }).join('')}
    </div>
  `;
};

window.saveConfig = async () => {
  const data = {};
  $$('[data-config]').forEach(el => { data[el.dataset.config] = el.value; });
  try { await api('/config', { method: 'PUT', body: JSON.stringify(data) }); toast('Config saved', 'success'); }
  catch (e) { toast(e.message, 'error'); }
};

pages.taxonomy = async () => {
  let tax = { categories: [], tags: [] };
  try { tax = await api('/taxonomy'); } catch {}
  return `
    <h1>Categories & Tags</h1>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <div><h2>Categories</h2>${tax.categories.map(c => `
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--color-border-light);font-size:13px">
          <span>${esc(c.name)} <small style="color:var(--color-text-tertiary)">(${c.count})</small></span>
          <button class="btn-sm" onclick="renameCat('${esc(c.name)}')"><i class="ri-edit-line"></i></button>
        </div>`).join('')}
      </div>
      <div><h2>Tags</h2>${tax.tags.map(t => `
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--color-border-light);font-size:13px">
          <span>#${esc(t.name)} <small style="color:var(--color-text-tertiary)">(${t.count})</small></span>
          <button class="btn-sm" onclick="renameTag('${esc(t.name)}')"><i class="ri-edit-line"></i></button>
        </div>`).join('')}
      </div>
    </div>
  `;
};

window.renameCat = async (old) => {
  const n = prompt('Rename "' + old + '" to:', old);
  if (!n || n === old) return;
  try { await api('/taxonomy/category', { method: 'PUT', body: JSON.stringify({ oldName: old, newName: n }) }); toast(`Renamed ${old} → ${n}`, 'success'); navigate('#taxonomy'); }
  catch (e) { toast(e.message, 'error'); }
};

window.renameTag = async (old) => {
  const n = prompt('Rename "' + old + '" to:', old);
  if (!n || n === old) return;
  try { await api('/taxonomy/tag', { method: 'PUT', body: JSON.stringify({ oldName: old, newName: n }) }); toast(`Renamed ${old} → ${n}`, 'success'); navigate('#taxonomy'); }
  catch (e) { toast(e.message, 'error'); }
};

// ── Upload ──
function setupUpload() {
  const zone = $('#upload-zone');
  const input = $('#file-input');
  if (!zone || !input) return;
  zone.onclick = () => input.click();
  zone.ondragover = e => { e.preventDefault(); };
  zone.ondrop = e => { e.preventDefault(); if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]); };
  input.onchange = () => { if (input.files.length) uploadFiles([...input.files]); input.value = ''; };
}

async function uploadFiles(files) {
  const slug = state.params.slug || $('#fm-slug')?.value || '';
  if (!slug) { toast('Save the post first (enter slug)', 'error'); return; }
  const p = $('#upload-progress');
  if (!p) return;
  p.innerHTML = '';
  for (const f of files) {
    const el = document.createElement('div');
    el.style.cssText = 'padding:6px 0;font-size:13px';
    el.textContent = `${f.name} — uploading...`;
    p.appendChild(el);
    try {
      const url = API + '/upload/direct/' + encodeURIComponent(slug) + '/' + encodeURIComponent(f.name);
      const xhr = new XMLHttpRequest();
      await new Promise((resolve, reject) => {
        xhr.upload.onprogress = e => { if (e.lengthComputable) el.textContent = `${f.name} — ${Math.round(e.loaded/e.total*100)}%`; };
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`));
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.open('POST', url);
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
        xhr.timeout = 300000;
        xhr.send(f);
      });
      el.innerHTML = `✅ ${f.name} — done`;
    } catch (e) { el.innerHTML = `❌ ${f.name} — ${esc(e.message)}`; }
  }
  toast('Upload complete! Trigger a build to process.', 'success');
  if (state.params.slug) loadExistingMedia(state.params.slug);
}

async function loadExistingMedia(slug) {
  const el = $('#existing-media');
  if (!el) return;
  try {
    const data = await api('/media/' + slug + '/list');
    let h = '<h3>Existing Media</h3>';
    if (data.photos?.length) {
      h += '<div class="media-grid">' + data.photos.map(p => `<div class="media-item"><img src="${API}/media/file/${encodeURIComponent(slug)}/${encodeURIComponent(p)}" onerror="this.style.display=\'none\'" alt="" /><div style="font-size:11px;padding:2px 4px">${esc(p)}</div></div>`).join('') + '</div>';
    }
    if (!data.photos?.length && !data.videos?.length) h += '<p style="color:var(--color-text-tertiary);font-size:13px">No media yet</p>';
    el.innerHTML = h;
  } catch { el.innerHTML = ''; }
}

// ── Init ──
(async () => {
  if (token) {
    try { await api('/auth/refresh', { method: 'POST' }); } catch { showLogin(); return; }
    $('#loading').style.display = 'none';
    $('#app').style.display = 'flex';
    navigate(location.hash || '#dashboard');
  } else {
    $('#loading').style.display = 'none';
    showLogin();
  }
})();
