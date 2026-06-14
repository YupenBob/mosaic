/**
 * Mosaic Cloud Admin — rewritten with proper SPA architecture
 * - AbortController cancels stale page loads (no more race conditions)
 * - Auth checked once at startup, no flash
 * - Clean page lifecycle with mount/unmount
 */
import { auth, posts as postsApi, media as mediaApi, upload, build, stats, config, taxonomy, trash, disk, health, track } from '../src/api.js';
import { getToken, setToken } from '../src/api.js';

// ── State ──────────────────────────────────
const state = {
  page: '',
  params: {},
  authStatus: 'checking', // 'checking' | 'ok' | 'expired'
  abortController: null,
  posts: [],
};

// ── Router ─────────────────────────────────
function onHashChange() {
  const raw = location.hash.replace('#', '') || 'dashboard';
  const [page, ...rest] = raw.split('&');
  const params = Object.fromEntries(new URLSearchParams(rest.join('&')));
  navigateTo(page, params);
}

function navigateTo(page, params = {}) {
  if (state.abortController) state.abortController.abort();
  state.abortController = new AbortController();
  state.page = page;
  state.params = params;
  updateNav(page);
  renderPage(page, state.abortController.signal);
}

function updateNav(page) {
  document.querySelectorAll('.nav-item[data-page]').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page);
  });
}

window.addEventListener('hashchange', onHashChange);
window.addEventListener('mosaic:auth-expired', () => { showLogin(); });

// ── Auth ───────────────────────────────────
function showLogin() {
  state.authStatus = 'expired';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  setToken(null);
}

window.mosaicLogin = async function() {
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  if (!password) { errorEl.style.display = 'block'; errorEl.textContent = 'Enter password'; return; }

  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line" style="animation:spin 1s linear infinite"></i> Signing in...';
  errorEl.style.display = 'none';

  try {
    const { token } = await auth.login(password);
    setToken(token);
    state.authStatus = 'ok';
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    onHashChange();
  } catch (err) {
    errorEl.style.display = 'block';
    errorEl.textContent = 'Login failed: ' + err.message + ' (API: https://mosaic-api.yupenbob.workers.dev)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
};

window.mosaicLogout = function() { showLogin(); };

// ── Render engine ──────────────────────────
const mainEl = () => document.getElementById('main-content');

async function renderPage(page, signal) {
  const m = mainEl();
  if (!m) return;
  m.innerHTML = '<div style="text-align:center;padding:60px;color:var(--color-text-tertiary)"><i class="ri-loader-4-line" style="font-size:24px;animation:spin 1s linear infinite"></i></div>';

  const renderer = pages[page];
  if (!renderer) { if (!signal.aborted) m.innerHTML = '<h1>404</h1><p>Page not found</p>'; return; }

  try {
    const result = await renderer(signal);
    if (signal.aborted) return;
    m.innerHTML = typeof result === 'string' ? result : result.html;
    if (result?.onMount && !signal.aborted) result.onMount();
  } catch (err) {
    if (signal.aborted) return;
    m.innerHTML = `<h1>Error</h1><p class="error">${err.message}</p>`;
  }
}

// ── Page renderers ─────────────────────────
const pages = {};

pages.dashboard = async (signal) => {
  const [dashData, healthData, trafficData, healthGithub, healthR2, cfg] = await Promise.all([
    stats.dashboard().catch(() => ({ posts: 0, categories: 0, tags: 0 })),
    health.check().catch(() => ({ status: 'error' })),
    stats.traffic().catch(() => ({ total: 0, posts: 0, byDay: [], byCategory: [], byTag: [], top5: [] })),
    health.github().catch(() => ({ status: 'error' })),
    health.r2().catch(() => ({ status: 'error' })),
    config.get().catch(() => ({})),
  ]);
  if (signal.aborted) return '';

  const siteUrl = cfg.url || '';
  const today = new Date().toISOString().slice(0, 10);
  const todayViews = (trafficData.byDay || []).find(d => d.date === today)?.count || 0;
  const weekViews = (trafficData.byDay || []).slice(-7).reduce((s, d) => s + d.count, 0);

  return {
    html: `
      <h1 style="margin-bottom:20px">Dashboard</h1>

      <!-- Health bar -->
      <div class="dash-health-bar">
        ${[{ name: 'API', status: healthData.status, info: healthData.version || 'v0.8' },
           { name: 'GitHub', status: healthGithub.status, info: healthGithub.latency ? `${healthGithub.latency}ms` : '—' },
           { name: 'R2', status: healthR2.status, info: healthR2.latency ? `${healthR2.latency}ms` : '—' },
           { name: 'Build', status: 'ok', info: 'Active' }].map(h => `
          <div class="dash-health-item">
            <span class="dash-health-dot ${h.status === 'ok' ? 'healthy' : 'down'}"></span>
            <span class="dash-health-name">${h.name}</span>
            <span class="dash-health-info">${h.info}</span>
          </div>`).join('')}
      </div>

      <!-- Quick stats -->
      <div class="dash-stats-row">
        <div class="dash-stat-card" style="--accent:#4361ee">
          <div class="dash-stat-icon"><i class="ri-article-line"></i></div>
          <div class="dash-stat-num">${dashData.posts || 0}</div>
          <div class="dash-stat-label">Posts</div>
        </div>
        <div class="dash-stat-card" style="--accent:#2ecc71">
          <div class="dash-stat-icon"><i class="ri-price-tag-3-line"></i></div>
          <div class="dash-stat-num">${dashData.categories || 0}</div>
          <div class="dash-stat-label">Categories</div>
        </div>
        <div class="dash-stat-card" style="--accent:#f0a500">
          <div class="dash-stat-icon"><i class="ri-hashtag"></i></div>
          <div class="dash-stat-num">${dashData.tags || 0}</div>
          <div class="dash-stat-label">Tags</div>
        </div>
        <div class="dash-stat-card" style="--accent:#9b59b6">
          <div class="dash-stat-icon"><i class="ri-eye-line"></i></div>
          <div class="dash-stat-num">${trafficData.total || 0}</div>
          <div class="dash-stat-label">Total Views</div>
        </div>
      </div>

      <!-- Traffic sub-stats -->
      <div class="dash-traffic-subs">
        <div class="dash-traffic-sub"><span>Today</span><strong>${todayViews}</strong></div>
        <div class="dash-traffic-sub"><span>This Week</span><strong>${weekViews}</strong></div>
        <div class="dash-traffic-sub"><span>Articles</span><strong>${trafficData.posts || 0}</strong></div>
      </div>

      <!-- Charts row -->
      <div class="dash-charts">
        <div class="dash-chart-card">
          <h3>Traffic (30 days)</h3>
          <div class="dash-chart-wrap"><canvas id="chart-traffic"></canvas></div>
        </div>
        <div class="dash-chart-card">
          <h3>Categories</h3>
          <div class="dash-chart-wrap"><canvas id="chart-categories"></canvas></div>
        </div>
      </div>

      <!-- Top 5 + Tags -->
      <div class="dash-bottom">
        <div class="dash-chart-card">
          <h3>Top Posts</h3>
          ${(trafficData.top5 || []).length ? trafficData.top5.map((t, i) => `
            <a href="#editor&slug=${encodeURIComponent(t.slug)}" class="dash-top-item">
              <span class="dash-top-rank">#${i+1}</span>
              <span class="dash-top-slug">${escHtml(t.slug)}</span>
              <span class="dash-top-count">${t.count}</span>
            </a>`).join('') : '<p style="color:var(--color-text-tertiary);padding:16px">No data yet</p>'}
        </div>
        <div class="dash-chart-card">
          <h3>Tags</h3>
          <div class="dash-chart-wrap"><canvas id="chart-tags"></canvas></div>
        </div>
      </div>

      <!-- Site preview -->
      ${siteUrl ? `
      <div class="dash-preview">
        <div class="dash-preview-header">
          <h3>Site Preview</h3>
          <a href="${siteUrl}" target="_blank" class="btn-sm" style="text-decoration:none">Open <i class="ri-external-link-line"></i></a>
        </div>
        <iframe src="${siteUrl}" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>
      </div>` : ''}
    `,
    onMount() {
      const dayLabels = (trafficData.byDay || []).map(d => d.date.slice(5));
      const dayData = (trafficData.byDay || []).map(d => d.count);
      const catLabels = (trafficData.byCategory || []).map(c => c.name);
      const catData = (trafficData.byCategory || []).map(c => c.count);
      const tagLabels = (trafficData.byTag || []).map(t => t.name);
      const tagData = (trafficData.byTag || []).map(t => t.count);

      makeChart('chart-traffic', 'line', dayLabels, dayData, '#4361ee');
      makeChart('chart-categories', 'doughnut', catLabels, catData, ['#4361ee','#2ecc71','#f0a500','#9b59b6','#e74c3c','#1abc9c','#3498db','#e67e22','#95a5a6','#34495e']);
      if (tagLabels.length) makeChart('chart-tags', 'bar', tagLabels, tagData, '#9b59b6');
    }
  };
};

function makeChart(id, type, labels, data, colors) {
  const canvas = document.getElementById(id);
  if (!canvas || !labels.length) return;
  new Chart(canvas, {
    type,
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: Array.isArray(colors) ? colors : colors + '33',
        borderColor: colors,
        borderWidth: type === 'line' ? 2 : 1,
        fill: type === 'line',
        tension: 0.3,
        pointRadius: type === 'line' ? 2 : 0,
        pointHoverRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: type === 'doughnut' } },
      scales: type !== 'doughnut' ? {
        x: { display: type === 'bar' },
        y: { beginAtZero: true, ticks: { precision: 0 } }
      } : {}
    }
  });
}

pages.posts = async (signal) => {
  const result = await postsApi.list();
  if (signal.aborted) return '';
  const postsData = result.posts || result;
  state.posts = postsData;
  return {
    html: `
      <div class="page-header">
        <h1>Posts (${postsData.length})</h1>
        <div style="display:flex;gap:8px">
          <div class="view-toggle">
            <button class="view-toggle-btn active" data-view="table" onclick="switchPostsView('table')"><i class="ri-list-check"></i></button>
            <button class="view-toggle-btn" data-view="cards" onclick="switchPostsView('cards')"><i class="ri-layout-grid-line"></i></button>
          </div>
          <button class="btn-primary" onclick="location.hash='editor'"><i class="ri-add-line"></i> New</button>
        </div>
      </div>
      <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">
        <input type="text" id="post-search" placeholder="Search posts..." style="flex:1;min-width:200px;max-width:320px;padding:8px;border:1px solid var(--color-border);border-radius:6px"
          oninput="filterPosts(this.value)" />
        <select id="post-cat-filter" onchange="filterPostsByCat(this.value)" style="padding:8px;border:1px solid var(--color-border);border-radius:6px;font-size:13px">
          <option value="">All categories</option>
          ${buildCatOptions(postsData)}
        </select>
      </div>
      <div id="posts-table-view">
        <table class="data-table" id="posts-table">
          <thead><tr><th>Title</th><th>Category</th><th>Tags</th><th>Date</th><th></th></tr></thead>
          <tbody>
          ${postsData.map(p => `
            <tr data-search="${(p.title||'') + ' ' + (p.category||'') + ' ' + (p.tags||[]).join(' ')}" data-cat="${escHtml(p.category||'')}">
              <td><a href="#editor&slug=${encodeURIComponent(p.slug)}" style="font-weight:500">${escHtml(p.title || p.slug)}</a></td>
              <td>${escHtml(p.category || '')}</td>
              <td>${(p.tags || []).map(t => '#' + escHtml(t)).join(' ')}</td>
              <td style="font-size:12px;color:var(--color-text-tertiary)">${p.date ? p.date.split('T')[0] : ''}</td>
              <td>
                <button onclick="location.hash='editor&slug=${encodeURIComponent(p.slug)}'" class="btn-sm"><i class="ri-edit-line"></i></button>
                <button onclick="doDeletePost('${escHtml(p.slug)}')" class="btn-sm" style="color:#e74c3c"><i class="ri-delete-bin-line"></i></button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div id="posts-cards-view" style="display:none">
        <div class="admin-card-grid">
          ${postsData.map(p => `
            <a href="#editor&slug=${encodeURIComponent(p.slug)}" class="admin-post-card" data-search="${(p.title||'') + ' ' + (p.category||'') + ' ' + (p.tags||[]).join(' ')}" data-cat="${escHtml(p.category||'')}">
              ${p.cover ? `<div class="admin-card-cover"><img src="/api/media/file/${encodeURIComponent(p.slug)}/${encodeURIComponent(p.cover)}" alt="${escHtml(p.title)}" loading="lazy" onerror="this.parentElement.style.display='none'" /></div>` : '<div class="admin-card-cover admin-card-cover-empty"><i class="ri-article-line" style="font-size:32px;color:var(--color-text-tertiary)"></i></div>'}
              <div class="admin-card-body">
                <span class="admin-card-cat">${escHtml((p.category || 'Uncategorized').split('/').pop())}</span>
                <h3 class="admin-card-title">${escHtml(p.title || p.slug)}</h3>
                ${p.description ? `<p class="admin-card-desc">${escHtml(p.description)}</p>` : ''}
                <div class="admin-card-tags">${(p.tags || []).slice(0, 5).map(t => '#' + escHtml(t)).join(' ')}</div>
              </div>
              <div class="admin-card-footer">
                <span>${p.date ? p.date.split('T')[0] : ''}</span>
                <span class="admin-card-actions" onclick="event.preventDefault()">
                  <button onclick="event.preventDefault();doDeletePost('${escHtml(p.slug)}')" class="btn-sm" style="color:#e74c3c;font-size:11px">Delete</button>
                </span>
              </div>
            </a>`).join('')}
        </div>
      </div>
    `,
    onMount() {
      // Restore saved view preference
      const savedView = localStorage.getItem('mosaic_posts_view') || 'table';
      switchPostsView(savedView, true);
    }
  };
};

pages.editor = async (signal) => {
  const slug = state.params.slug || '';
  let post = { slug: '', frontMatter: {}, body: '' };
  if (slug) {
    try { post = await postsApi.get(slug); } catch { /* new post */ }
  }
  if (signal.aborted) return '';

  const fm = post.frontMatter || {};
  const layouts = ['default', 'video-first', 'gallery-first', 'music-first'];

  return {
    html: `
      <div class="page-header">
        <h1>${slug ? 'Edit: ' + escHtml(fm.title || slug) : 'New Post'}</h1>
        <div style="display:flex;gap:8px">
          <button class="btn-primary" onclick="doSavePost()"><i class="ri-save-line"></i> Save</button>
        </div>
      </div>
      <div class="editor-layout">
        <div class="editor-fields">
          <label>Slug <input type="text" id="fm-slug" value="${escHtml(slug)}" ${slug ? 'readonly' : ''} /></label>
          <label>Title <input type="text" id="fm-title" value="${escHtml(fm.title || '')}" /></label>
          <label>Date <input type="date" id="fm-date" value="${fm.date || new Date().toISOString().split('T')[0]}" /></label>
          <label>Category <input type="text" id="fm-category" value="${escHtml(fm.category || '')}" placeholder="e.g. photography/nature" /><small style="color:var(--color-text-tertiary)">Use / for multi-level, e.g. photography/nature</small></label>
          <label>Tags <input type="text" id="fm-tags" value="${(fm.tags || []).join(', ')}" /></label>
          <label>Description <textarea id="fm-desc" rows="2">${escHtml(fm.description || '')}</textarea></label>
          <label>Layout <select id="fm-layout">${layouts.map(l => `<option value="${l}" ${fm.layout === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Cover <input type="text" id="fm-cover" value="${escHtml(fm.cover || '')}" placeholder="cover.jpg or video:0 or photo:0" /></label>
        </div>
        <div class="editor-body">
          <textarea id="fm-body" style="width:100%;height:400px;font-family:var(--font-mono);font-size:14px;padding:12px;border:1px solid var(--color-border);border-radius:6px">${escHtml(post.body || '')}</textarea>
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
        <div id="existing-media" style="margin-top:16px"></div>
      </div>
    `,
    onMount() {
      if (slug) loadExistingMedia(slug);
    }
  };
};

pages.build = async (signal) => {
  let statusData = null, historyData = { runs: [] };
  try {
    [statusData, historyData] = await Promise.all([
      build.status().catch(() => null),
      build.history().catch(() => ({ runs: [] })),
    ]);
  } catch {}
  if (signal.aborted) return '';

  const runs = historyData.runs || [];
  const latest = statusData && statusData.status !== 'unknown' ? statusData : runs[0] || null;

  return {
    html: `
      <div class="page-header">
        <h1>Build & Deploy</h1>
        <div style="display:flex;gap:8px">
          <button class="btn-primary" onclick="doTriggerBuild()"><i class="ri-play-fill"></i> Build & Deploy</button>
          <button class="btn-secondary" onclick="location.reload()"><i class="ri-refresh-line"></i></button>
        </div>
      </div>
      <div id="build-status-card">${latest ? renderStatusCard(latest) : renderEmptyState()}</div>
      ${runs.length > 0 ? `<div id="build-history">${renderRunHistory(runs)}</div>` : ''}
    `,
    onMount() {
      let pollTimer;
      const poll = async () => {
        try {
          const s = await build.status();
          const card = document.getElementById('build-status-card');
          if (card && s && s.status !== 'unknown') {
            card.innerHTML = renderStatusCard(s);
          }
          // If build is no longer running, stop polling
          if (s && s.status !== 'in_progress' && s.status !== 'queued') {
            clearInterval(pollTimer);
            // Refresh history
            const h = await build.history().catch(() => ({ runs: [] }));
            const histEl = document.getElementById('build-history');
            if (histEl) histEl.innerHTML = (h.runs || []).length > 0 ? renderRunHistory(h.runs) : '';
          }
        } catch {}
      };
      pollTimer = setInterval(poll, 5000);
      // Cleanup on page leave
      const cleanup = () => clearInterval(pollTimer);
      window.addEventListener('hashchange', cleanup, { once: true });
    }
  };
};

function renderStatusCard(run) {
  const statusDef = getStatusDef(run.status, run.conclusion);
  const time = formatTime(run.createdAt);
  return `
    <div style="background:var(--color-surface);border:1px solid var(--color-border-light);border-radius:10px;padding:20px 24px;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div style="width:12px;height:12px;border-radius:50%;background:${statusDef.color};${run.status === 'in_progress' ? 'animation:pulse 1.5s infinite' : ''}"></div>
        <span style="font-size:18px;font-weight:600">
          #${run.runNumber || '—'}
          ${run.displayTitle ? ' — ' + escHtml(run.displayTitle) : ''}
        </span>
        <span style="padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;background:${statusDef.bg};color:${statusDef.color}">
          ${statusDef.label}
        </span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;font-size:13px;color:var(--color-text-secondary)">
        <div><span style="color:var(--color-text-tertiary)">Branch</span><br><span style="font-family:var(--font-mono)">${escHtml(run.headBranch || 'main')}</span></div>
        <div><span style="color:var(--color-text-tertiary)">Commit</span><br><span style="font-family:var(--font-mono)">${escHtml(run.headSha || '—')}</span></div>
        <div><span style="color:var(--color-text-tertiary)">Event</span><br>${escHtml(run.event || 'push')}</div>
        <div><span style="color:var(--color-text-tertiary)">Time</span><br>${time}</div>
      </div>
      ${run.commitMessage ? `<div style="margin-top:10px;font-size:13px;color:var(--color-text-secondary)">${escHtml(run.commitMessage)}</div>` : ''}
      ${run.htmlUrl ? `
        <a href="${run.htmlUrl}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;margin-top:12px;font-size:13px;color:var(--color-accent);text-decoration:none">
          View on GitHub <i class="ri-external-link-line"></i>
        </a>` : ''}
    </div>
  `;
}

function renderRunHistory(runs) {
  return `
    <h2 style="margin-bottom:12px">Build History</h2>
    <div style="display:flex;flex-direction:column;gap:2px">
      ${runs.map((r, i) => {
        const s = getStatusDef(r.status, r.conclusion);
        const time = formatTime(r.createdAt);
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:${i === 0 ? 'var(--color-surface)' : 'transparent'};border-radius:6px;font-size:13px;border:1px solid ${i === 0 ? 'var(--color-border-light)' : 'transparent'}">
            <span style="font-family:var(--font-mono);font-weight:600;min-width:48px">#${r.runNumber}</span>
            <span style="padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600;background:${s.bg};color:${s.color};min-width:70px;text-align:center">${s.label}</span>
            <span style="flex:1;color:var(--color-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.displayTitle || r.commitMessage || '')}</span>
            <span style="font-family:var(--font-mono);font-size:11px;color:var(--color-text-tertiary);min-width:56px;text-align:right">${escHtml(r.headSha || '')}</span>
            <span style="font-size:11px;color:var(--color-text-tertiary);min-width:80px;text-align:right">${time}</span>
            ${r.htmlUrl ? `<a href="${r.htmlUrl}" target="_blank" class="btn-sm" style="text-decoration:none">View details <i class="ri-external-link-line"></i></a>` : ''}
          </div>`;
      }).join('')}
    </div>
  `;
}

function renderEmptyState() {
  return `
    <div style="text-align:center;padding:48px 24px;background:var(--color-surface);border:2px dashed var(--color-border);border-radius:10px;margin-bottom:20px">
      <i class="ri-tools-line" style="font-size:48px;color:var(--color-text-tertiary)"></i>
      <h2 style="margin:12px 0 4px">No Builds Yet</h2>
      <p style="color:var(--color-text-secondary);margin-bottom:16px">Upload media to a post and trigger your first build.</p>
      <button class="btn-primary" onclick="doTriggerBuild()"><i class="ri-play-fill"></i> Build & Deploy</button>
    </div>
  `;
}

function getStatusDef(status, conclusion) {
  if (status === 'in_progress' || status === 'queued') return { label: status === 'queued' ? 'Queued' : 'Running', color: '#f0a500', bg: 'rgba(240,165,0,0.12)' };
  if (conclusion === 'success') return { label: 'Success', color: '#2ecc71', bg: 'rgba(46,204,113,0.12)' };
  if (conclusion === 'failure') return { label: 'Failed', color: '#e74c3c', bg: 'rgba(231,76,60,0.12)' };
  if (conclusion === 'cancelled') return { label: 'Cancelled', color: '#6e6e73', bg: 'rgba(110,110,115,0.12)' };
  if (conclusion === 'skipped') return { label: 'Skipped', color: '#6e6e73', bg: 'rgba(110,110,115,0.12)' };
  return { label: status || 'Unknown', color: '#86868b', bg: 'rgba(134,134,139,0.1)' };
}

function buildCatOptions(postsData) {
  const tree = {};
  for (const p of postsData) {
    if (!p.category) continue;
    const parts = p.category.split('/');
    let node = tree;
    let path = '';
    for (const part of parts) {
      const name = part.trim();
      if (!name) continue;
      path += (path ? '/' : '') + name;
      if (!node[name]) node[name] = { fullPath: path };
      node = node[name];
    }
  }
  function render(node, depth) {
    return Object.entries(node).map(([name, info]) =>
      `<option value="${escHtml(info.fullPath)}">${'&nbsp;&nbsp;'.repeat(depth)}${depth > 0 ? '└ ' : ''}${escHtml(name)}</option>` +
      render(info, depth + 1)
    ).join('');
  }
  return render(tree, 0);
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

pages.config = async (signal) => {
  let cfg = {};
  try { cfg = await config.get(); } catch {}
  if (signal.aborted) return '';

  const fields = [
    ['title', 'Site Title', 'text'],
    ['subtitle', 'Subtitle', 'text'],
    ['description', 'Description', 'textarea'],
    ['url', 'Site URL', 'text'],
    ['language', 'Language', 'text'],
    ['pageSize', 'Posts Per Page', 'number'],
    ['gallerySingleThreshold', 'Gallery Threshold', 'number'],
  ];

  return `
    <div class="page-header"><h1>Site Configuration</h1><button class="btn-primary" onclick="doSaveConfig()"><i class="ri-save-line"></i> Save</button></div>
    <div class="config-form">
      ${fields.map(([key, label, type]) => renderConfigField(key, cfg[key], label, type)).join('')}
      <h3 style="margin-top:20px">Giscus Comments</h3>
      ${renderConfigField('giscus.repo', cfg.giscus?.repo || '', 'GitHub Repo')}
      ${renderConfigField('giscus.category', cfg.giscus?.category || 'Announcements', 'Category')}
    </div>
  `;
};

pages.taxonomy = async (signal) => {
  let tax = { categories: [], tags: [] };
  try { tax = await taxonomy.get(); } catch {}
  if (signal.aborted) return '';
  return `
    <h1>Categories & Tags</h1>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
      <div>
        <h2>Categories</h2>
        ${renderCatTree(tax.categories, '') || '<p style="color:var(--color-text-tertiary)">None</p>'}
      </div>
      <div>
        <h2>Tags</h2>
        ${tax.tags.map(t => `
          <div style="padding:8px 0;border-bottom:1px solid var(--color-border-light);display:flex;justify-content:space-between;align-items:center">
            <span>#${escHtml(t.name)} <small style="color:var(--color-text-tertiary)">(${t.count})</small></span>
            <button class="btn-sm" onclick="doRenameTag('${escHtml(t.name)}')"><i class="ri-edit-line"></i></button>
          </div>`).join('') || '<p style="color:var(--color-text-tertiary)">None</p>'}
      </div>
    </div>
  `;
};

function renderCatTree(cats, prefix, depth=0) {
  if (!cats || !cats.length) return '';
  return cats.map(c => {
    const fullName = prefix ? `${prefix}/${c.name}` : c.name;
    const hasChildren = c.children && c.children.length > 0;
    return `
      <div style="border-bottom:1px solid var(--color-border-light)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;padding-left:${depth*20}px">
          <span>
            ${hasChildren ? `<i class="ri-arrow-down-s-line cat-toggle" data-cat="${escHtml(fullName)}" onclick="toggleCatChildren(this)" style="cursor:pointer;margin-right:4px;font-size:14px"></i>` : '<span style="display:inline-block;width:18px"></span>'}
            ${escHtml(c.name)}
            <small style="color:var(--color-text-tertiary)">(${c.count})</small>
          </span>
          <button class="btn-sm" onclick="doRenameCategory('${escHtml(fullName)}')"><i class="ri-edit-line"></i></button>
        </div>
        ${hasChildren ? `<div class="cat-children" data-cat="${escHtml(fullName)}">${renderCatTree(c.children, fullName, depth+1)}</div>` : ''}
      </div>`;
  }).join('');
}

window.toggleCatChildren = function(icon) {
  const catName = icon.dataset.cat;
  const children = document.querySelector(`.cat-children[data-cat="${CSS.escape(catName)}"]`);
  if (children) {
    children.style.display = children.style.display === 'none' ? '' : 'none';
    icon.classList.toggle('ri-arrow-down-s-line');
    icon.classList.toggle('ri-arrow-right-s-line');
  }
};

pages.trash = async (signal) => {
  let items = [];
  try { items = await trash.list(); } catch {}
  if (signal.aborted) return '';
  return `
    <div class="page-header"><h1>Trash</h1></div>
    ${items.length ? items.map(t => `
      <div style="padding:8px;border-bottom:1px solid var(--color-border-light);display:flex;justify-content:space-between;align-items:center">
        <span>${escHtml(t.title || t.dir || '')}</span>
        <div>
          <button class="btn-sm" onclick="doRestoreTrash('${escHtml(t.dir)}')"><i class="ri-arrow-go-back-line"></i> Restore</button>
          <button class="btn-sm" style="color:#e74c3c" onclick="doPermanentDelete('${escHtml(t.dir)}')"><i class="ri-delete-bin-line"></i></button>
        </div>
      </div>`).join('') : '<p style="color:var(--color-text-tertiary)">Trash is empty</p>'}
  `;
};

pages.deploy = () => `
  <h1>Deploy</h1>
  <p style="color:var(--color-text-secondary);margin-bottom:16px">Build & deploy are now unified. Use the <a href="#build" style="color:var(--color-accent)">Build page</a> to trigger deployment.</p>
  <button class="btn-primary" onclick="location.hash='build'"><i class="ri-tools-line"></i> Go to Build</button>
`;

// ── Helpers ─────────────────────────────────
function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderConfigField(key, value, label, type = 'text') {
  const isTextarea = type === 'textarea';
  return `<label style="display:block;margin-bottom:12px">
    <span style="font-size:13px;color:var(--color-text-secondary)">${label}</span>
    ${isTextarea
      ? `<textarea data-config="${key}" style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--color-border);border-radius:6px" rows="3">${escHtml(value || '')}</textarea>`
      : `<input type="${type}" data-config="${key}" value="${escHtml(value || '')}" style="width:100%;margin-top:4px;padding:8px;border:1px solid var(--color-border);border-radius:6px" />`}
  </label>`;
}

// ── Existing media display ─────────────────
async function loadExistingMedia(slug) {
  const el = document.getElementById('existing-media');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:13px">Loading media...</p>';
  try {
    const data = await mediaApi.list(slug);
    let html = '<h3 style="margin-bottom:8px">Existing Media</h3>';
    if (data.photos?.length) {
      html += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">' +
        data.photos.map(f => `
          <div style="position:relative;border:1px solid var(--color-border-light);border-radius:6px;overflow:hidden;background:var(--color-surface)">
            <img src="${f.url || f.name}" alt="${escHtml(f.name)}" style="width:100px;height:100px;object-fit:cover;display:block" onerror="this.outerHTML=''" />
            <div style="padding:2px 6px;font-size:11px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
            <button onclick="doDeleteMedia('${escHtml(slug)}','${escHtml(f.name)}','photos')" style="width:100%;border:none;background:var(--color-surface);color:#e74c3c;font-size:11px;cursor:pointer;padding:2px;border-top:1px solid var(--color-border-light)">Delete</button>
          </div>`).join('') +
        '</div>';
    }
    if (data.videos?.length) {
      html += '<div style="margin-bottom:12px">' +
        data.videos.map(f => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border:1px solid var(--color-border-light);border-radius:4px;margin-bottom:4px;font-size:13px;background:var(--color-surface)">
            <span><i class="ri-video-line" style="margin-right:4px;color:var(--color-accent)"></i>${escHtml(f.name)}</span>
            <button onclick="doDeleteMedia('${escHtml(slug)}','${escHtml(f.name)}','videos')" class="btn-sm" style="color:#e74c3c">Delete</button>
          </div>`).join('') +
        '</div>';
    }
    if (!data.photos?.length && !data.videos?.length) {
      html += '<p style="color:var(--color-text-tertiary)">No media uploaded yet. Use the upload zone above.</p>';
    }
    el.innerHTML = html;
  } catch {
    el.innerHTML = '<p style="color:var(--color-text-tertiary)">Could not load media</p>';
  }
}

// ── Upload flow ────────────────────────────
function getCurrentSlug() {
  return state.params.slug || document.getElementById('fm-slug')?.value || '';
}

async function handleUploadFiles(files) {
  const slug = getCurrentSlug();
  if (!slug) { alert('Please save the post first (fill in the slug field)'); return; }

  const progressEl = document.getElementById('upload-progress');
  if (!progressEl) return;
  progressEl.innerHTML = '';

  const token = getToken();
  let done = 0;
  const total = files.length;

  for (const file of files) {
    const itemEl = document.createElement('div');
    itemEl.style.cssText = 'padding:4px 0;font-size:13px';
    itemEl.textContent = `${file.name} — uploading...`;
    progressEl.appendChild(itemEl);

    try {
      const url = upload.directUrl(slug, file.name);
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) itemEl.textContent = `${file.name} — ${Math.round(e.loaded / e.total * 100)}%`;
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`HTTP ${xhr.status}`));
        });
        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.open('POST', url);
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.send(file);
      });
      done++;
      itemEl.innerHTML = `<i class="ri-check-line" style="color:#2ecc71"></i> ${file.name} — done (${done}/${total})`;
    } catch (err) {
      itemEl.innerHTML = `<i class="ri-close-line" style="color:#e74c3c"></i> ${file.name} — ${escHtml(err.message)}`;
    }
  }

  if (done > 0) {
    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'margin-top:8px;font-weight:500';
    statusEl.textContent = 'Triggering build...';
    progressEl.appendChild(statusEl);
    try {
      await build.trigger();
      statusEl.innerHTML = '<i class="ri-check-line" style="color:#2ecc71"></i> Build queued — check <a href="#build" style="color:var(--color-accent)">Build page</a> for status';
    } catch (err) {
      statusEl.innerHTML = `<i class="ri-close-line" style="color:#e74c3c"></i> Build trigger failed: ${escHtml(err.message)}. Files are uploaded but the site won't update until a build runs.`;
    }
    loadExistingMedia(slug);
  }
}

function setupUploadZone() {
  const main = document.getElementById('main-content');
  if (!main) return;

  main.addEventListener('click', e => {
    const zone = e.target.closest('.upload-zone');
    if (!zone) return;
    zone.querySelector('input[type="file"]')?.click();
  });

  main.addEventListener('change', e => {
    if (!e.target.closest('#editor-media-input')) return;
    if (e.target.files?.length) handleUploadFiles([...e.target.files]);
    e.target.value = '';
  });

  main.addEventListener('dragover', e => {
    if (e.target.closest('.upload-zone')) { e.preventDefault(); e.stopPropagation(); }
  });

  main.addEventListener('drop', e => {
    const zone = e.target.closest('.upload-zone');
    if (!zone) return;
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer?.files?.length) handleUploadFiles([...e.dataTransfer.files]);
  });
}

// ── Global actions ─────────────────────────
window.doSavePost = async () => {
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
    if (state.params.slug) {
      await postsApi.update(state.params.slug, { frontMatter, body });
    } else {
      await postsApi.create({ slug, frontMatter, body });
    }
    location.hash = 'posts';
  } catch (err) { alert('Save failed: ' + err.message); }
};

window.doDeletePost = async (slug) => {
  if (!confirm('Delete "' + slug + '"?')) return;
  try { await postsApi.delete(slug); location.reload(); }
  catch (err) { alert('Delete failed: ' + err.message); }
};

window.doDeleteMedia = async (slug, file, type) => {
  if (!confirm('Delete ' + file + '?')) return;
  try { await mediaApi.delete(slug, file, type); location.reload(); }
  catch (err) { alert('Delete failed: ' + err.message); }
};

window.doTriggerBuild = async () => {
  try {
    const result = await build.trigger();
    let msg = `Build triggered via ${result.method || 'unknown'}!`;
    if (result.wfError) msg += `\n(workflow_dispatch failed: ${result.wfError})`;
    alert(msg);
    location.hash = 'build';
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('already in progress') || msg.includes('BUILD_RUNNING')) {
      // Extract run info from error
      try {
        const statusData = await build.status();
        const go = confirm(`A build is already running!\n\n#${statusData.runNumber || '?'} — ${statusData.status || 'in_progress'}\n\nClick OK to view status, Cancel to stay here.`);
        if (go) location.hash = 'build';
      } catch { alert('A build is already in progress. Please wait for it to finish.'); }
    } else {
      alert('Build trigger failed: ' + msg);
    }
  }
};

window.doSaveConfig = async () => {
  const data = {};
  document.querySelectorAll('[data-config]').forEach(el => {
    const keys = el.dataset.config.split('.');
    let obj = data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = el.value;
  });
  try { await config.update(data); alert('Config saved!'); }
  catch (err) { alert('Save failed: ' + err.message); }
};

window.doRenameCategory = async (oldName) => {
  const newName = prompt('Rename category "' + oldName + '" to:', oldName);
  if (!newName || newName === oldName) return;
  try { await taxonomy.renameCategory(oldName, newName); alert('Renamed ' + oldName + ' → ' + newName); location.reload(); }
  catch (err) { alert('Rename failed: ' + err.message); }
};

window.doRenameTag = async (oldName) => {
  const newName = prompt('Rename tag "' + oldName + '" to:', oldName);
  if (!newName || newName === oldName) return;
  try { await taxonomy.renameTag(oldName, newName); alert('Renamed ' + oldName + ' → ' + newName); location.reload(); }
  catch (err) { alert('Rename failed: ' + err.message); }
};

window.doRestoreTrash = async (dir) => {
  try { await trash.restore(dir); location.reload(); }
  catch (err) { alert('Restore failed: ' + err.message); }
};

window.doPermanentDelete = async (dir) => {
  if (!confirm('Permanently delete "' + dir + '"?')) return;
  try { await trash.permanentDelete(dir); location.reload(); }
  catch (err) { alert('Delete failed: ' + err.message); }
};

window.switchPostsView = (view, silent) => {
  const tableEl = document.getElementById('posts-table-view');
  const cardsEl = document.getElementById('posts-cards-view');
  if (tableEl) tableEl.style.display = view === 'cards' ? 'none' : '';
  if (cardsEl) cardsEl.style.display = view === 'cards' ? '' : 'none';
  document.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (!silent) localStorage.setItem('mosaic_posts_view', view);
  // Re-apply current filter
  const searchQ = document.getElementById('post-search')?.value || '';
  const catQ = document.getElementById('post-cat-filter')?.value || '';
  window.filterPosts(searchQ);
  if (catQ) window.filterPostsByCat(catQ);
};

window.filterPosts = (query) => {
  const q = query.toLowerCase();
  document.querySelectorAll('#posts-table tbody tr, .admin-post-card').forEach(el => {
    if (!q) { el.style.display = ''; return; }
    el.style.display = (el.dataset.search || '').toLowerCase().includes(q) ? '' : 'none';
  });
};

window.filterPostsByCat = (cat) => {
  document.querySelectorAll('#posts-table tbody tr, .admin-post-card').forEach(el => {
    if (!cat) { el.style.display = ''; return; }
    el.style.display = (el.dataset.cat || '') === cat ? '' : 'none';
  });
};

// ── Init ───────────────────────────────────
async function init() {
  const loadingEl = document.getElementById('loading-screen');
  const hideLoading = () => { if (loadingEl) loadingEl.style.display = 'none'; };

  // Safety: hide loading after 5s no matter what
  setTimeout(hideLoading, 5000);

  const token = getToken();
  if (token) {
    try {
      await auth.refresh();
      state.authStatus = 'ok';
    } catch {
      hideLoading();
      showLogin();
      return;
    }
    hideLoading();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    setupUploadZone();
    onHashChange();
  } else {
    hideLoading();
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Spin animation
const styleEl = document.createElement('style');
styleEl.textContent = '@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}';
document.head.appendChild(styleEl);
