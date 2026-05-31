var API = '/api';
var currentPage = 'dashboard';
var currentSlug = null;
var allPosts = [];
var sortBy = 'date-desc';
var postFilter = '';
var postFilterCat = '';
var postFilterTag = '';

// ====== Navigation ======
document.querySelectorAll('.nav-item').forEach(function(a) {
  a.addEventListener('click', function(e) { e.preventDefault(); showPage(a.dataset.page); });
});

function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  var pg = document.getElementById('page-' + page);
  if (pg) pg.classList.add('active');
  var nav = document.querySelector('[data-page="' + page + '"]');
  if (nav) nav.classList.add('active');
  if (page === 'dashboard') loadDashboard();
  if (page === 'posts') loadPosts();
  if (page === 'editor' && !currentSlug) resetEditor();
  if (page === 'editor') loadEditorMedia();
  if (page === 'config') loadConfigPage();
  if (page === 'git') loadGitPage();
  if (page === 'build') loadBuildHistory();
  if (page === 'deploy') document.getElementById('deploy-log').textContent = '';
}

// ====== Toast ======
function toast(msg) {
  var t = document.getElementById('_toast');
  if (!t) { t = document.createElement('div'); t.id = '_toast'; t.style.cssText = 'position:fixed;bottom:28px;right:28px;background:#1d1d1f;color:#fff;padding:10px 20px;border-radius:10px;font-size:13px;z-index:9999;opacity:0;transform:translateY(12px);transition:all .3s ease;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.2)'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._timer); t._timer = setTimeout(function(){ t.classList.remove('show'); }, 2000);
}

// ====== Toast (CSS class override) ======
document.addEventListener('DOMContentLoaded', function(){
  var style = document.createElement('style');
  style.textContent = '#_toast.show{opacity:1;transform:translateY(0)}';
  document.head.appendChild(style);
});

// ====== Dashboard ======
async function loadDashboard() {
  var stats = await fetch(API + '/stats').then(function(r){ return r.json(); }).catch(function(){ return {}; });
  var html = '<div class="stat-card"><div class="stat-num">' + (stats.posts||0) + '</div><div class="stat-label">Posts</div></div>';
  html += '<div class="stat-card"><div class="stat-num">' + (stats.categories||0) + '</div><div class="stat-label">Categories</div></div>';
  html += '<div class="stat-card"><div class="stat-num">' + (stats.tags||0) + '</div><div class="stat-label">Tags</div></div>';
  var logs = await fetch(API + '/logs').then(function(r){ return r.json(); }).catch(function(){ return []; });
  if (logs.length) html += '<div class="stat-card"><div class="stat-num" style="font-size:14px">' + new Date(logs[0].time).toLocaleString() + '</div><div class="stat-label">Last Build</div></div>';
  var disk = await fetch(API + '/disk').then(function(r){ return r.json(); }).catch(function(){ return {}; });
  html += '<div class="stat-card"><div class="stat-num" style="font-size:18px">' + (disk.contentMB||'?') + ' MB</div><div class="stat-label">Content Disk</div></div>';
  document.getElementById('stats').innerHTML = html;

  // Quick create
  document.getElementById('recent-posts').innerHTML = '<div style="display:flex;gap:8px;margin-bottom:12px"><input type="text" id="quick-title" placeholder="Quick create — enter title..." style="flex:1;padding:8px;border:1px solid #d2d2d7;border-radius:6px" onkeydown="if(event.key===\'Enter\')quickCreate()" /><button class="btn-primary" onclick="quickCreate()">Create</button></div>';

  var files = await fetch(API + '/recent-files').then(function(r){ return r.json(); }).catch(function(){ return []; });
  document.getElementById('recent-posts').innerHTML += '<strong>Recent Files</strong><br>' + files.map(function(f){ return '<div class="recent-item"><span style="font-family:monospace;font-size:12px">' + f.path + '</span> &middot; ' + new Date(f.mtime).toLocaleString() + '</div>'; }).join('');
}

function quickCreate() {
  var title = document.getElementById('quick-title').value.trim();
  if (!title) return;
  var slug = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
  currentSlug = null; resetEditor();
  document.getElementById('fm-slug').value = slug;
  document.getElementById('fm-title').value = title;
  document.getElementById('fm-date').value = new Date().toISOString().slice(0,10);
  showPage('editor'); toast('Created draft: ' + slug);
}

// ====== Posts ======
async function loadPosts() {
  var raw = await fetch(API + '/posts').then(function(r){ return r.json(); }).catch(function(){ return []; });
  allPosts = raw;
  renderPostsTable();
  updateFilterDropdowns();
  // Double-click to edit
  setTimeout(function(){
    document.querySelectorAll('#posts-table tbody tr').forEach(function(row){
      row.addEventListener('dblclick', function(e){
        var slug = row.querySelector('a')?.textContent;
        if (!slug && row.querySelector('small')) slug = row.querySelector('small').textContent;
        if (slug) editPost(slug);
      });
    });
  }, 200);
}

function sortPosts(field) {
  if (sortBy === field + '-desc') sortBy = field + '-asc'; else sortBy = field + '-desc';
  renderPostsTable();
}

function filterPosts(q) { postFilter = q.toLowerCase(); renderPostsTable(); }
function filterCat(cat) { postFilterCat = cat; renderPostsTable(); updateFilterDropdowns(); }
function filterTag(tag) { postFilterTag = tag; renderPostsTable(); updateFilterDropdowns(); }

function updateFilterDropdowns() {
  var cats = {}; var tags = {};
  allPosts.forEach(function(p){ cats[p.category||'']=1; (p.tags||[]).forEach(function(t){ tags[t]=1; }); });
  var catSel = document.getElementById('filter-cat');
  var tagSel = document.getElementById('filter-tag');
  if (catSel) { catSel.innerHTML = '<option value="">All Categories</option>' + Object.keys(cats).sort().map(function(c){ return '<option'+(c===postFilterCat?' selected':'')+'>'+c+'</option>'; }).join(''); }
  if (tagSel) { tagSel.innerHTML = '<option value="">All Tags</option>' + Object.keys(tags).sort().map(function(t){ return '<option'+(t===postFilterTag?' selected':'')+'>'+t+'</option>'; }).join(''); }
}

function renderPostsTable() {
  var posts = allPosts.slice();
  if (postFilterCat) posts = posts.filter(function(p){ return (p.category||'') === postFilterCat; });
  if (postFilterTag) posts = posts.filter(function(p){ return (p.tags||[]).indexOf(postFilterTag) >= 0; });
  if (postFilter) posts = posts.filter(function(p){ return (p.title||'').toLowerCase().indexOf(postFilter)>=0 || (p.slug||'').toLowerCase().indexOf(postFilter)>=0 || (p.category||'').toLowerCase().indexOf(postFilter)>=0 || (p.tags||[]).join(' ').toLowerCase().indexOf(postFilter)>=0; });
  if (sortBy === 'date-asc') posts.sort(function(a,b){ return new Date(a.date)-new Date(b.date); });
  else if (sortBy === 'date-desc') posts.sort(function(a,b){ return new Date(b.date)-new Date(a.date); });
  else if (sortBy === 'title-asc') posts.sort(function(a,b){ return (a.title||'').localeCompare(b.title||''); });
  else if (sortBy === 'title-desc') posts.sort(function(a,b){ return (b.title||'').localeCompare(a.title||''); });

  var tbody = document.querySelector('#posts-table tbody');
  tbody.innerHTML = posts.map(function(p){
    var thumb = '';
    if (p.cover) {
      thumb = '<img src="/content/posts/' + p.slug + '/' + p.cover + '" style="width:44px;height:33px;object-fit:cover;border-radius:4px;margin-right:8px" loading="lazy" />';
    } else if (p.photoCount > 0) {
      thumb = '<div style="width:44px;height:33px;background:#f0f0f3;border-radius:4px;margin-right:8px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#86868b">' + p.photoCount + 'p</div>';
    } else if (p.videoCount > 0) {
      thumb = '<div style="width:44px;height:33px;background:#f0f0f3;border-radius:4px;margin-right:8px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#86868b">' + p.videoCount + 'v</div>';
    }
    var tags = (p.tags||[]).map(function(t){ return '<span class="tag-badge">'+t+'</span>'; }).join(' ');
    return '<tr><td style="width:44px;padding-right:0"><input type="checkbox" class="post-check" value="' + p.slug + '" /></td><td style="display:flex;align-items:center">' + thumb + '<div><a href="javascript:editPost(\'' + p.slug + '\')"><strong>' + (p.title||p.slug) + '</strong></a><br><small>' + p.slug + '</small></div></td><td>' + (p.category||'-') + '</td><td>' + tags + '</td><td>' + (p.photoCount||0) + '</td><td>' + (p.videoCount||0) + '</td><td>' + (p.date||'').slice(0,10) + '</td><td>' +
      '<button class="btn-sm" onclick="editPost(\'' + p.slug + '\')">Edit</button> ' +
      '<button class="btn-sm" style="color:#f39c12" onclick="duplicatePost(\'' + p.slug + '\')">Dup</button> ' +
      '<button class="btn-sm" style="color:#e74c3c" onclick="deletePost(\'' + p.slug + '\')">Del</button></td></tr>';
  }).join('');
}

function batchDelete() {
  var checked = document.querySelectorAll('.post-check:checked');
  if (!checked.length) return toast('Select posts first');
  if (!confirm('Delete ' + checked.length + ' posts?')) return;
  Promise.all(Array.from(checked).map(function(cb){ return fetch(API+'/posts/'+cb.value,{method:'DELETE'}); })).then(function(){ loadPosts(); toast('Deleted '+checked.length+' posts'); });
}

async function duplicatePost(slug) {
  var r = await fetch(API+'/posts/'+slug+'/duplicate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:slug+'-copy'})});
  var d = await r.json();
  if (d.ok) { loadPosts(); toast('Duplicated: ' + d.slug); }
  else toast(d.error || 'Error');
}

function newPost() { currentSlug = null; resetEditor(); showPage('editor'); }

async function editPost(slug) {
  currentSlug = slug;
  var p = await fetch(API + '/posts/' + slug).then(function(r){ return r.json(); }).catch(function(){ return null; });
  if (!p) return toast('Post not found');
  document.getElementById('editor-title').textContent = 'Edit: ' + (p.frontMatter.title || slug);
  document.getElementById('fm-slug').value = slug;
  document.getElementById('fm-title').value = p.frontMatter.title || '';
  document.getElementById('fm-date').value = (p.frontMatter.date || '').slice(0,10);
  document.getElementById('fm-category').value = p.frontMatter.category || '';
  document.getElementById('fm-tags').value = (p.frontMatter.tags || []).join(', ');
  document.getElementById('fm-desc').value = p.frontMatter.description || '';
  document.getElementById('fm-layout').value = p.frontMatter.layout || 'default';
  document.getElementById('fm-cover').value = p.frontMatter.cover || '';
  document.getElementById('fm-body').value = p.body || '';
  showPage('editor');
  loadEditorMedia();
}

function resetEditor() {
  document.getElementById('editor-title').textContent = 'New Post';
  ['slug','title','date','category','tags','desc','cover','body'].forEach(function(id){
    var el = document.getElementById('fm-' + id); if (el) el.value = '';
  });
  document.getElementById('fm-layout').value = 'default';
  updateWordCount();
  autoSaveClear();
}

// ====== Autosave ======
var _autoSaveTimer;
function autoSaveDraft() {
  var slug = document.getElementById('fm-slug').value.trim() || currentSlug || '__draft__';
  var draft = {
    slug: document.getElementById('fm-slug').value,
    title: document.getElementById('fm-title').value,
    date: document.getElementById('fm-date').value,
    category: document.getElementById('fm-category').value,
    tags: document.getElementById('fm-tags').value,
    desc: document.getElementById('fm-desc').value,
    layout: document.getElementById('fm-layout').value,
    cover: document.getElementById('fm-cover').value,
    body: document.getElementById('fm-body').value,
    time: Date.now(),
  };
  try { localStorage.setItem('mosaic-draft-' + slug, JSON.stringify(draft)); } catch(e) {}
}
function autoSaveClear() { try { var slug = currentSlug || '__draft__'; localStorage.removeItem('mosaic-draft-' + slug); } catch(e) {} }

// Start autosave on editor
document.addEventListener('DOMContentLoaded', function(){
  var bodyEl = document.getElementById('fm-body');
  if (bodyEl) {
    bodyEl.addEventListener('input', function(){ updateWordCount(); });
    setInterval(function(){ if(currentPage==='editor') autoSaveDraft(); }, 30000);
  }
});

// Check for draft on edit
function checkDraft(slug) {
  try {
    var draft = JSON.parse(localStorage.getItem('mosaic-draft-' + (slug||'__draft__')));
    if (draft && draft.time) return draft;
  } catch(e) {}
  return null;
}

// ====== Validation & Word Count ======
function validatePost() {
  var slug = document.getElementById('fm-slug').value.trim();
  var title = document.getElementById('fm-title').value.trim();
  if (!slug) { toast('Slug is required'); return false; }
  if (!title) { toast('Title is required'); return false; }
  return true;
}

function updateWordCount() {
  var el = document.getElementById('fm-body');
  var wc = document.getElementById('_wordcount');
  if (!wc) { wc = document.createElement('span'); wc.id = '_wordcount'; wc.style.cssText = 'position:absolute;bottom:4px;right:8px;font-size:11px;color:#86868b'; el.parentElement.style.position = 'relative'; el.parentElement.appendChild(wc); }
  var text = el.value || ''; wc.textContent = text.replace(/\s/g, '').length + ' chars';
}

async function savePost() {
  if (!validatePost()) return;
  var slug = document.getElementById('fm-slug').value.trim();
  var body = {
    slug: slug,
    frontMatter: {
      title: document.getElementById('fm-title').value,
      date: document.getElementById('fm-date').value,
      category: document.getElementById('fm-category').value,
      tags: document.getElementById('fm-tags').value.split(',').map(function(s){ return s.trim(); }).filter(Boolean),
      description: document.getElementById('fm-desc').value,
      layout: document.getElementById('fm-layout').value,
      cover: document.getElementById('fm-cover').value,
    },
    body: document.getElementById('fm-body').value,
  };
  var method = currentSlug ? 'PUT' : 'POST';
  var url = currentSlug ? API + '/posts/' + currentSlug : API + '/posts';
  var r = await fetch(url, { method: method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (r.ok) { toast('Saved!'); currentSlug = slug; loadEditorMedia(); autoSaveClear(); }
  else toast('Error saving');
}

function previewPost() {
  var slug = currentSlug || document.getElementById('fm-slug').value;
  if (!slug) return toast('Save post first');
  window.open('http://localhost:3000/posts/' + slug + '/', '_blank');
}

async function deletePost(slug) {
  if (!confirm('Delete ' + slug + '?')) return;
  await fetch(API + '/posts/' + slug, { method:'DELETE' });
  loadPosts(); toast('Deleted');
}

// ====== Markdown Preview ======
var _mdOn = false;
function togglePreview() {
  _mdOn = !_mdOn;
  var ta = document.getElementById('fm-body');
  var wrapper = ta.parentElement;
  var prev = document.getElementById('_mdpreview');
  if (_mdOn) {
    if (!prev) {
      wrapper.style.display = 'flex'; wrapper.style.gap = '0';
      prev = document.createElement('div'); prev.id = '_mdpreview'; prev.className = 'md-preview';
      wrapper.appendChild(prev);
      ta.style.flex = '1'; ta.style.width = '';
    }
    prev.style.display = '';
    updatePreview();
  } else {
    if (prev) prev.style.display = 'none';
    ta.style.flex = ''; ta.style.width = '100%';
  }
}

function updatePreview() {
  var prev = document.getElementById('_mdpreview');
  if (!prev || prev.style.display === 'none') return;
  var md = (document.getElementById('fm-body')||{}).value || '';
  prev.innerHTML = '<p>' + md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>').replace(/^\- (.+)$/gm,'<li>$1</li>').replace(/\n\n/g,'</p><p>') + '</p>';
}

// Live preview update on input
document.addEventListener('DOMContentLoaded', function(){
  var bodyEl = document.getElementById('fm-body');
  if (bodyEl) bodyEl.addEventListener('input', function(){ updatePreview(); });
});

// ====== Drag & Paste Upload ======
document.addEventListener('DOMContentLoaded', function(){
  var bodyEl = document.getElementById('fm-body');
  if (!bodyEl) return;
  // Drag
  var dragDiv = document.createElement('div');
  dragDiv.className = 'drag-zone'; dragDiv.textContent = 'Drop images here to upload';
  dragDiv.style.display = 'none';
  bodyEl.parentElement.insertBefore(dragDiv, bodyEl);

  bodyEl.addEventListener('dragover', function(e){ e.preventDefault(); dragDiv.style.display = 'block'; });
  bodyEl.addEventListener('dragleave', function(){ dragDiv.style.display = 'none'; });
  bodyEl.addEventListener('drop', function(e){
    e.preventDefault(); dragDiv.style.display = 'none';
    var files = e.dataTransfer.files;
    if (files.length) uploadFiles(files);
  });
  // Paste
  bodyEl.addEventListener('paste', function(e){
    var items = e.clipboardData.items;
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') >= 0) files.push(items[i].getAsFile());
    }
    if (files.length) uploadFiles(files);
  });
});

async function uploadFiles(files) {
  var slug = currentSlug || document.getElementById('fm-slug').value.trim();
  if (!slug) return toast('Save post first');
  var form = new FormData(); form.append('type', 'photos');
  for (var i = 0; i < files.length; i++) form.append('files', files[i]);
  await fetch(API + '/posts/' + slug + '/media', { method:'POST', body:form });
  loadEditorMedia(); toast('Uploaded ' + files.length + ' files');
}

// ====== Editor Media ======
async function loadEditorMedia() {
  var slug = currentSlug || document.getElementById('fm-slug').value.trim();
  if (!slug) { document.getElementById('editor-media-grid').innerHTML = '<p style="color:#86868b">Save post first</p>'; return; }
  var data = await fetch(API + '/posts/' + slug + '/media').then(function(r){ return r.json(); }).catch(function(){ return {}; });
  var grid = document.getElementById('editor-media-grid'), html = '';
  (data.photos||[]).forEach(function(f){
    html += '<div class="media-item"><img src="/content/posts/' + slug + '/photos/' + f + '" alt="" loading="lazy" /><div class="media-name">' + f + '</div><div class="media-del"><button class="btn-sm" style="color:#e74c3c" onclick="delEditorMedia(\'' + slug + '\',\'' + f + '\')">Del</button></div></div>';
  });
  (data.videos||[]).forEach(function(f){
    html += '<div class="media-item"><video src="/content/posts/' + slug + '/videos/' + f + '" controls></video><div class="media-name">' + f + '</div><div class="media-del"><button class="btn-sm" style="color:#e74c3c" onclick="delEditorMedia(\'' + slug + '\',\'' + f + '\')">Del</button></div></div>';
  });
  grid.innerHTML = html || '<p style="color:#86868b">No media files</p>';
}

async function uploadEditorMedia() {
  var slug = currentSlug || document.getElementById('fm-slug').value.trim();
  if (!slug) return toast('Save post first');
  var input = document.getElementById('editor-media-input');
  if (!input.files.length) return;
  var form = new FormData(); form.append('type', 'photos');
  for (var i = 0; i < input.files.length; i++) form.append('files', input.files[i]);
  await fetch(API + '/posts/' + slug + '/media', { method:'POST', body:form });
  input.value = ''; loadEditorMedia(); toast('Uploaded');
}

async function delEditorMedia(slug, file) {
  await fetch(API + '/posts/' + slug + '/media/' + file, { method:'DELETE' });
  loadEditorMedia();
}

// ====== Build ======
function triggerBuild() {
  var log = document.getElementById('build-log'); log.textContent = '';
  var btn = document.querySelector('#page-build .btn-primary');
  if (btn) { btn.classList.add('btn-loading'); btn.innerHTML = '<i class="ri-loader-4-line"></i> Building...'; }
  var evt = new EventSource(API + '/build');
  evt.onmessage = function(e){ log.textContent += e.data + '\n'; log.scrollTop = log.scrollHeight; };
  evt.onerror = function(){
    evt.close(); log.textContent += '\n--- Done ---'; loadBuildHistory();
    if (btn) { btn.classList.remove('btn-loading'); btn.innerHTML = '<i class="ri-play-fill"></i> Build'; }
    // Browser notification
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Mosaic Build Complete', { body: 'Site has been rebuilt.', icon: '/assets/logo.svg' });
    } else if ('Notification' in window && Notification.permission !== 'denied') {
      Notification.requestPermission().then(function(p){ if (p==='granted') new Notification('Mosaic Build Complete', {body:'Site rebuilt.'}); });
    }
  };
}

async function quickAction(name) {
  var log = document.getElementById('build-log'); log.textContent = 'Running ' + name + '...\n';
  var r = await fetch(API + '/actions/' + name, { method:'POST' });
  var d = await r.json(); log.textContent += d.output || d.error || 'Done'; toast(name + ' done');
}

async function loadBuildHistory() {
  var logs = await fetch(API + '/logs').then(function(r){ return r.json(); }).catch(function(){ return []; });
  var el = document.getElementById('build-history');
  if (!el) return;
  el.innerHTML = logs.map(function(l){ return '<div class="recent-item"><a href="javascript:viewLog(\'' + l.name + '\')">' + l.name + '</a> &middot; ' + new Date(l.time).toLocaleString() + '</div>'; }).join('') || '<p style="color:#86868b">No build history</p>';
}

async function viewLog(name) {
  var text = await fetch(API + '/logs/' + name).then(function(r){ return r.text(); });
  document.getElementById('build-log').textContent = text;
}

// ====== Config ======
function cfgRow(key, label, value, type) {
  var id = 'cfg-' + key.replace(/\./g, '_');
  if (type === 'checkbox') return '<label class="cfg-label"><input type="checkbox" id="' + id + '" ' + (value ? 'checked' : '') + ' /> ' + label + '</label>';
  if (type === 'number') return '<label class="cfg-label">' + label + ' <input type="number" id="' + id + '" value="' + (value||'') + '" /></label>';
  if (type === 'textarea') return '<label class="cfg-label">' + label + ' <textarea id="' + id + '" rows="2">' + (value||'') + '</textarea></label>';
  return '<label class="cfg-label">' + label + ' <input type="text" id="' + id + '" value="' + (value||'') + '" /></label>';
}

async function loadConfigPage() {
  var cfg = await fetch(API + '/config').then(function(r){ return r.json(); }).catch(function(){ return {}; });
  var html = '<div class="cfg-section"><h3>Site Info</h3>';
  html += cfgRow('title','Title',cfg.title); html += cfgRow('subtitle','Subtitle',cfg.subtitle);
  html += cfgRow('description','Description',cfg.description,'textarea'); html += cfgRow('url','Site URL',cfg.url);
  html += cfgRow('language','Language',cfg.language); html += '</div><div class="cfg-section"><h3>Author</h3>';
  html += cfgRow('author.name','Name',cfg.author?cfg.author.name:''); html += cfgRow('author.email','Email',cfg.author?cfg.author.email:'');
  html += '</div><div class="cfg-section"><h3>Display</h3>';
  html += cfgRow('dateFormat','Date Format',cfg.dateFormat||'YYYY-MM-DD');
  html += cfgRow('pageSize','Posts Per Page',cfg.pageSize,'number');
  html += cfgRow('gallerySingleThreshold','Gallery Threshold',cfg.gallerySingleThreshold,'number');
  html += cfgRow('coverAspectMin','Aspect Min',cfg.coverAspectMin,'number');
  html += cfgRow('coverAspectMax','Aspect Max',cfg.coverAspectMax,'number');
  html += cfgRow('enableBusuanzi','Busuanzi',cfg.enableBusuanzi,'checkbox');
  html += cfgRow('enableVideoCompression','Video Compression',cfg.enableVideoCompression,'checkbox');
  html += '</div><div class="cfg-section"><h3>Giscus</h3>';
  html += cfgRow('giscus.repo','Repo',cfg.giscus?cfg.giscus.repo:''); html += cfgRow('giscus.repoId','Repo ID',cfg.giscus?cfg.giscus.repoId:'');
  html += cfgRow('giscus.category','Category',cfg.giscus?cfg.giscus.category:''); html += cfgRow('giscus.categoryId','Category ID',cfg.giscus?cfg.giscus.categoryId:'');
  html += '</div>'; document.getElementById('config-editor').innerHTML = html;
}

function setNested(obj, path, val) {
  var keys = path.split('.'), cur = obj;
  for (var i = 0; i < keys.length - 1; i++) { if (!cur[keys[i]]) cur[keys[i]] = {}; cur = cur[keys[i]]; }
  cur[keys[keys.length - 1]] = val;
}

async function saveConfig() {
  var cfg = {};
  document.querySelectorAll('#config-editor input, #config-editor textarea').forEach(function(el){
    var key = el.id.replace('cfg-', '').replace(/_/g, '.');
    var val = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? (parseFloat(el.value)||0) : el.value);
    setNested(cfg, key, val);
  });
  await fetch(API + '/config', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(cfg) });
  toast('Config saved');
}

// ====== Git ======
async function loadGitPage() {
  try {
    var r = await fetch(API + '/git/status').then(function(r){ return r.json(); });
    document.getElementById('git-status').innerHTML = '<strong>Branch:</strong> ' + (r.branch||'?') + '<br><pre class="git-status-pre">' + (r.status||'Clean') + '</pre>';
  } catch(e) { document.getElementById('git-status').textContent = 'Git unavailable'; }
}

async function gitCommit() {
  var msg = document.getElementById('git-message').value.trim();
  if (!msg) return toast('Enter a message');
  var r = await fetch(API + '/git/commit', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message:msg}) });
  var d = await r.json(); toast(d.ok ? 'Pushed!' : 'Error'); loadGitPage();
}

// ====== Deploy ======
async function deployTo(target) {
  var log = document.getElementById('deploy-log'); log.textContent = 'Deploying to ' + target + '...\n';
  var r = await fetch(API + '/deploy/' + target, { method:'POST' });
  var d = await r.json(); log.textContent += d.output || d.error || 'Done'; toast('Deploy triggered');
}

// ====== Auto slug ======
document.addEventListener('DOMContentLoaded', function(){
  var titleEl = document.getElementById('fm-title'), slugEl = document.getElementById('fm-slug');
  if (titleEl && slugEl) titleEl.addEventListener('input', function(){
    if (!currentSlug) slugEl.value = titleEl.value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
  });
  showPage('dashboard');
});

// ====== Upload Zone ======
document.addEventListener('DOMContentLoaded', function(){
  var zone = document.getElementById('upload-zone');
  var input = document.getElementById('editor-media-input');
  if (!zone || !input) return;
  zone.addEventListener('click', function(){ input.click(); });
  zone.addEventListener('dragover', function(e){ e.preventDefault(); zone.style.borderColor = '#3651d4'; zone.style.background = 'rgba(67,97,238,0.08)'; });
  zone.addEventListener('dragleave', function(){ zone.style.borderColor = '#4361ee'; zone.style.background = 'rgba(67,97,238,0.04)'; });
  zone.addEventListener('drop', function(e){
    e.preventDefault(); zone.style.borderColor = '#4361ee'; zone.style.background = 'rgba(67,97,238,0.04)';
    if (e.dataTransfer.files.length) uploadWithProgress(e.dataTransfer.files);
  });
  input.addEventListener('change', function(){ if (input.files.length) uploadWithProgress(input.files); });
});

async function uploadWithProgress(files) {
  var slug = currentSlug || document.getElementById('fm-slug').value.trim();
  if (!slug) return toast('Save post first');
  var progress = document.getElementById('upload-progress');
  progress.innerHTML = '';
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var bar = document.createElement('div');
    bar.className = 'upload-bar';
    bar.innerHTML = '<span>' + f.name + '</span><div class="upload-bar-track"><div class="upload-bar-fill" id="bar-' + i + '"></div></div>';
    progress.appendChild(bar);
  }
  var form = new FormData(); form.append('type', 'photos');
  for (var i = 0; i < files.length; i++) form.append('files', files[i]);
  var xhr = new XMLHttpRequest();
  xhr.open('POST', API + '/posts/' + slug + '/media');
  xhr.upload.onprogress = function(e){
    if (e.lengthComputable) {
      var pct = Math.round(e.loaded / e.total * 100);
      for (var i = 0; i < files.length; i++) {
        var el = document.getElementById('bar-' + i);
        if (el) el.style.width = pct + '%';
      }
    }
  };
  xhr.onload = function(){ progress.innerHTML = ''; loadEditorMedia(); toast('Uploaded ' + files.length + ' files'); };
  xhr.send(form);
}

// ====== Keyboard Shortcuts ======
document.addEventListener('keydown', function(e){
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (currentPage === 'editor') savePost(); }
    if (e.key === 'Escape') { if (_mdOn) togglePreview(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (currentPage === 'editor') savePost(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); if (currentPage === 'editor') previewPost(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); newPost(); showPage('editor'); }
  if (e.key === 'Escape') { if (_mdOn) togglePreview(); else showPage('dashboard'); }
});

// ====== Health Check ======
async function loadHealthCheck() {
  var h = await fetch(API + '/health').then(function(r){ return r.json(); }).catch(function(){ return {}; });
  var el = document.getElementById('health-status');
  if (!el) return;
  if (h.ok) el.innerHTML = '<span style="color:#2ecc71">All clear</span>';
  else el.innerHTML = '<span style="color:#e74c3c">' + h.count + ' issues</span><br>' + (h.issues||[]).slice(0,5).map(function(i){ return '<small>' + i.slug + ': ' + i.msg + '</small><br>'; }).join('');
}

// ====== Taxonomy ======
async function loadTaxonomyPage() {
  var tax = await fetch(API + '/taxonomy').then(function(r){ return r.json(); }).catch(function(){ return {}; });
  var catHtml = '<table class="data-table"><thead><tr><th>Category</th><th>Posts</th><th></th></tr></thead><tbody>';
  (tax.categories||[]).forEach(function(c){
    catHtml += '<tr><td><span contenteditable="true" id="cat-' + c.name.replace(/\s/g,'-') + '">' + c.name + '</span></td><td>' + c.count + '</td><td><button class="btn-sm" onclick="renameCat(\'' + c.name + '\')">Rename</button></td></tr>';
  });
  catHtml += '</tbody></table>';
  document.getElementById('tax-categories').innerHTML = catHtml;

  var tagHtml = '<table class="data-table"><thead><tr><th>Tag</th><th>Posts</th><th></th></tr></thead><tbody>';
  (tax.tags||[]).forEach(function(t){
    tagHtml += '<tr><td><span contenteditable="true" id="tag-' + t.name.replace(/\s/g,'-') + '">' + t.name + '</span></td><td>' + t.count + '</td><td><button class="btn-sm" onclick="renameTag(\'' + t.name + '\')">Rename</button></td></tr>';
  });
  tagHtml += '</tbody></table>';
  document.getElementById('tax-tags').innerHTML = tagHtml;
}

async function renameCat(oldName) {
  var newName = prompt('Rename "' + oldName + '" to:', oldName);
  if (!newName || newName === oldName) return;
  var r = await fetch(API + '/taxonomy/category', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({oldName:oldName,newName:newName}) });
  var d = await r.json(); toast('Renamed ' + d.renamed + ' posts'); loadTaxonomyPage();
}

async function renameTag(oldName) {
  var newName = prompt('Rename #"' + oldName + '" to:', oldName);
  if (!newName || newName === oldName) return;
  var r = await fetch(API + '/taxonomy/tag', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({oldName:oldName,newName:newName}) });
  var d = await r.json(); toast('Renamed ' + d.renamed + ' posts'); loadTaxonomyPage();
}

// ====== Trash ======
async function loadTrashPage() {
  var items = await fetch(API + '/trash').then(function(r){ return r.json(); }).catch(function(){ return []; });
  var el = document.getElementById('trash-list');
  if (!items.length) { el.innerHTML = '<p style="color:#86868b">Trash is empty</p>'; return; }
  el.innerHTML = '<table class="data-table"><thead><tr><th>Title</th><th>Deleted</th><th></th></tr></thead><tbody>' +
    items.map(function(i){ return '<tr><td>' + (i.title||i.dir) + '</td><td>' + new Date(i.mtime).toLocaleString() + '</td><td><button class="btn-sm" onclick="restoreTrash(\'' + i.dir + '\')">Restore</button> <button class="btn-sm" style="color:#e74c3c" onclick="permDelete(\'' + i.dir + '\')">Delete</button></td></tr>'; }).join('') +
    '</tbody></table>';
}

async function restoreTrash(dir) {
  await fetch(API + '/trash/' + dir + '/restore', { method:'POST' });
  loadTrashPage(); loadPosts(); toast('Restored');
}

async function permDelete(dir) {
  if (!confirm('Permanently delete?')) return;
  await fetch(API + '/trash/' + dir, { method:'DELETE' });
  loadTrashPage(); toast('Deleted');
}

async function emptyTrash() {
  if (!confirm('Empty entire trash?')) return;
  var items = await fetch(API + '/trash').then(function(r){ return r.json(); }).catch(function(){ return []; });
  for (var i = 0; i < items.length; i++) await fetch(API + '/trash/' + items[i].dir, { method:'DELETE' });
  loadTrashPage(); toast('Trash emptied');
}

// Update showPage for new pages
var _origShowPage = showPage;
showPage = function(page) {
  _origShowPage(page);
  if (page === 'dashboard') loadHealthCheck();
  if (page === 'taxonomy') loadTaxonomyPage();
  if (page === 'trash') loadTrashPage();
};

// ====== R2 Status ======
async function loadR2Status() {
  var r = await fetch(API + '/r2/status').then(function(r){ return r.json(); }).catch(function(){ return {}; });
  var el = document.getElementById('r2-status');
  if (!el) return;
  if (r.configured) el.innerHTML = '<span style="color:#2ecc71">R2: ' + r.bucket + '</span>';
  else el.innerHTML = '<span style="color:#e74c3c">R2 not configured</span>';
}

// Update showPage to load R2
var _origShowPage2 = showPage;
showPage = function(page) {
  _origShowPage2(page);
  if (page === 'deploy' || page === 'dashboard') loadR2Status();
};
