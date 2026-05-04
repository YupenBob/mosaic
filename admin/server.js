import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import multer from 'multer';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT = path.join(ROOT, 'content', 'posts');
const PORT = 4000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(ROOT, 'src', 'assets')));
// Serve content files for media preview
app.use('/content', express.static(path.join(ROOT, 'content')));

// Multer for media uploads
const upload = multer({ dest: path.join(ROOT, 'admin', 'uploads') });
const LOG_DIR = path.join(__dirname, 'logs');

// ====== API ======

// List all posts
app.get('/api/posts', (req, res) => {
  try {
    const dirs = fs.readdirSync(CONTENT).filter((d) => {
      try { return fs.statSync(path.join(CONTENT, d)).isDirectory(); } catch { return false; }
    });
    const posts = dirs.map((slug) => {
      const mdPath = path.join(CONTENT, slug, 'index.md');
      if (!fs.existsSync(mdPath)) return { slug, title: slug, error: 'No index.md' };
      const raw = fs.readFileSync(mdPath, 'utf-8');
      const { data } = matter(raw);
      const photosDir = path.join(CONTENT, slug, 'photos');
      const videosDir = path.join(CONTENT, slug, 'videos');
      const photoCount = fs.existsSync(photosDir) ? fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)).length : 0;
      const videoCount = fs.existsSync(videosDir) ? fs.readdirSync(videosDir).filter(f => /\.(mp4|mov|avi|mkv)$/i.test(f)).length : 0;
      const stat = fs.statSync(mdPath);
      return {
        slug, title: data.title || slug, date: data.date || '',
        category: data.category || '', tags: data.tags || [],
        cover: data.cover || '', photoCount, videoCount,
        mtime: stat.mtime.toISOString(),
      };
    }).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(posts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get single post
app.get('/api/posts/:slug', (req, res) => {
  try {
    const mdPath = path.join(CONTENT, req.params.slug, 'index.md');
    if (!fs.existsSync(mdPath)) return res.status(404).json({ error: 'Not found' });
    const raw = fs.readFileSync(mdPath, 'utf-8');
    const { data, content } = matter(raw);
    res.json({ slug: req.params.slug, frontMatter: data, body: content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create post
app.post('/api/posts', (req, res) => {
  try {
    const { slug, frontMatter, body } = req.body;
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const dir = path.join(CONTENT, slug);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fm = { ...frontMatter, date: frontMatter.date || new Date().toISOString().split('T')[0] };
    const md = '---\n' + Object.entries(fm).map(([k, v]) => {
      if (Array.isArray(v)) return k + ': [' + v.join(', ') + ']';
      return k + ': ' + (typeof v === 'string' && v.includes(':') ? '"' + v + '"' : v);
    }).join('\n') + '\n---\n\n' + (body || '');
    fs.writeFileSync(path.join(dir, 'index.md'), md);
    // Ensure photos/videos dirs
    ['photos', 'videos'].forEach(d => { const dp = path.join(dir, d); if (!fs.existsSync(dp)) fs.mkdirSync(dp); });
    res.json({ ok: true, slug });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update post
app.put('/api/posts/:slug', (req, res) => {
  try {
    const { frontMatter, body } = req.body;
    const mdPath = path.join(CONTENT, req.params.slug, 'index.md');
    if (!fs.existsSync(mdPath)) return res.status(404).json({ error: 'Not found' });
    const fm = { ...frontMatter };
    const md = '---\n' + Object.entries(fm).map(([k, v]) => {
      if (Array.isArray(v)) return k + ': [' + v.join(', ') + ']';
      return k + ': ' + (typeof v === 'string' && v.includes(':') ? '"' + v + '"' : v);
    }).join('\n') + '\n---\n\n' + (body || '');
    fs.writeFileSync(mdPath, md);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete post → move to trash
const TRASH = path.join(ROOT, 'content', '.trash');

app.delete('/api/posts/:slug', (req, res) => {
  try {
    const dir = path.join(CONTENT, req.params.slug);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
    const trashDir = path.join(TRASH, req.params.slug + '-' + Date.now());
    if (!fs.existsSync(TRASH)) fs.mkdirSync(TRASH, { recursive: true });
    fs.renameSync(dir, trashDir);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Trash list
app.get('/api/trash', (req, res) => {
  try {
    if (!fs.existsSync(TRASH)) return res.json([]);
    const items = fs.readdirSync(TRASH).map(d => {
      const p = path.join(TRASH, d);
      try {
        const stat = fs.statSync(p);
        const mdPath = path.join(p, 'index.md');
        let title = d;
        if (fs.existsSync(mdPath)) {
          const { data } = matter(fs.readFileSync(mdPath, 'utf-8'));
          title = data.title || d;
        }
        return { dir: d, title, mtime: stat.mtime.toISOString() };
      } catch { return { dir: d, title: d, mtime: '' }; }
    });
    res.json(items);
  } catch (e) { res.json([]); }
});

// Restore from trash
app.post('/api/trash/:dir/restore', (req, res) => {
  try {
    const src = path.join(TRASH, req.params.dir);
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Not found' });
    // Extract original slug (remove timestamp suffix)
    const slug = req.params.dir.replace(/-\d{13}$/, '');
    const dest = path.join(CONTENT, slug);
    let finalDest = dest, n = 1;
    while (fs.existsSync(finalDest)) finalDest = path.join(CONTENT, slug + '-' + (n++));
    fs.renameSync(src, finalDest);
    res.json({ ok: true, slug: path.basename(finalDest) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Permanent delete from trash
app.delete('/api/trash/:dir', (req, res) => {
  try {
    const p = path.join(TRASH, req.params.dir);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
    fs.rmSync(p, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload media
app.post('/api/posts/:slug/media', upload.array('files', 20), (req, res) => {
  try {
    const slug = req.params.slug;
    const type = req.body.type || 'photos';
    const destDir = path.join(CONTENT, slug, type);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const files = [];
    (req.files || []).forEach(f => {
      const dest = path.join(destDir, f.originalname);
      fs.copyFileSync(f.path, dest);
      fs.unlinkSync(f.path);
      files.push(f.originalname);
    });
    res.json({ ok: true, files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List media
app.get('/api/posts/:slug/media', (req, res) => {
  try {
    const dir = path.join(CONTENT, req.params.slug);
    const result = {};
    ['photos', 'videos'].forEach(type => {
      const d = path.join(dir, type);
      result[type] = fs.existsSync(d) ? fs.readdirSync(d).filter(f => !f.startsWith('.')) : [];
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete media
app.delete('/api/posts/:slug/media/:file', (req, res) => {
  try {
    const slug = req.params.slug;
    const file = req.params.file;
    ['photos', 'videos'].forEach(type => {
      const p = path.join(CONTENT, slug, type, file);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Build (SSE) — also saves log
app.get('/api/build', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let fullLog = '';
  const emit = (d) => { fullLog += d; res.write('data: ' + d.toString().replace(/\n/g, '\ndata: ') + '\n\n'); };
  const proc = spawn('node', [path.join(ROOT, 'scripts', 'build.js')], { cwd: ROOT });
  proc.stdout.on('data', emit);
  proc.stderr.on('data', emit);
  proc.on('close', (code) => {
    emit('[Build exit ' + code + ']\n');
    const fname = 'build-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.log';
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, fname), fullLog);
    res.end();
  });
});

// Dashboard stats
app.get('/api/stats', (req, res) => {
  try {
    const dirs = fs.readdirSync(CONTENT).filter(d => fs.statSync(path.join(CONTENT, d)).isDirectory());
    const cats = new Set(), tags = new Set();
    dirs.forEach(slug => {
      const mdPath = path.join(CONTENT, slug, 'index.md');
      if (!fs.existsSync(mdPath)) return;
      const { data } = matter(fs.readFileSync(mdPath, 'utf-8'));
      if (data.category) cats.add(data.category);
      (data.tags || []).forEach(t => tags.add(t));
    });
    res.json({ posts: dirs.length, categories: cats.size, tags: tags.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Config ======
const CONFIG_PATH = path.join(ROOT, 'mosaic.config.json');

app.get('/api/config', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/config', (req, res) => {
  try {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    // Deep merge: preserve nested objects
    const merged = { ...existing, ...req.body };
    if (req.body.author) merged.author = { ...existing.author, ...req.body.author };
    if (req.body.giscus) merged.giscus = { ...existing.giscus, ...req.body.giscus };
    if (req.body.imageQuality) merged.imageQuality = { ...existing.imageQuality, ...req.body.imageQuality };
    if (req.body.videoQuality) merged.videoQuality = { ...existing.videoQuality, ...req.body.videoQuality };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Git ======
function runCmd(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: cwd || ROOT });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, stdout: out, stderr: err }));
    p.on('error', reject);
  });
}

app.get('/api/git/status', async (req, res) => {
  try {
    const s = await runCmd('git', ['status', '--short']);
    const b = await runCmd('git', ['branch', '--show-current']);
    res.json({ status: s.stdout, branch: b.stdout.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/git/commit', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    await runCmd('git', ['add', '-A']);
    const r = await runCmd('git', ['commit', '-m', message]);
    await runCmd('git', ['push']);
    res.json({ ok: true, output: r.stdout + r.stderr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Deploy ======
app.post('/api/deploy/:target', async (req, res) => {
  const target = req.params.target;
  try {
    if (target === 'gh-pages') {
      const r = await runCmd('gh', ['workflow', 'run', 'deploy.yml']);
      res.json({ ok: true, output: r.stdout + r.stderr });
    } else if (target === 'cf') {
      const r = await runCmd('gh', ['workflow', 'run', 'deploy-cf.yml']);
      res.json({ ok: true, output: r.stdout + r.stderr });
    } else if (target === 'vercel') {
      const r = await runCmd('npx', ['vercel', '--prod', '--yes']);
      res.json({ ok: true, output: r.stdout + r.stderr });
    } else {
      res.status(400).json({ error: 'Unknown target: ' + target });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Export ======
app.get('/api/export/content', async (req, res) => {
  try {
    const { execSync } = await import('child_process');
    const tmp = path.join(ROOT, 'admin', 'tmp_content.zip');
    execSync('tar -a -cf "' + tmp + '" -C "' + ROOT + '" content', { stdio: 'ignore' });
    res.download(tmp, 'mosaic-content.zip', () => { try { fs.unlinkSync(tmp); } catch {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Build History ======

app.get('/api/logs', (req, res) => {
  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log')).sort().reverse().slice(0, 20);
    res.json(files.map(f => ({ name: f, time: fs.statSync(path.join(LOG_DIR, f)).mtime.toISOString() })));
  } catch (e) { res.json([]); }
});

app.get('/api/logs/:name', (req, res) => {
  try {
    const p = path.join(LOG_DIR, req.params.name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
    res.type('text').send(fs.readFileSync(p, 'utf-8'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Quick Actions ======
app.post('/api/actions/:name', async (req, res) => {
  try {
    const name = req.params.name;
    const actions = {
      'install': ['npm', ['install']],
      'demo': ['node', ['scripts/generate-demo.js']],
      'clean-build': ['node', ['scripts/build.js', '--clean']],
    };
    const act = actions[name];
    if (!act) return res.status(400).json({ error: 'Unknown action' });
    const r = await runCmd(act[0], act[1]);
    res.json({ ok: true, output: r.stdout + r.stderr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Health Check ======
app.get('/api/health', (req, res) => {
  try {
    const issues = [];
    const dirs = fs.readdirSync(CONTENT).filter(d => fs.statSync(path.join(CONTENT, d)).isDirectory() && !d.startsWith('.'));
    dirs.forEach(slug => {
      const mdPath = path.join(CONTENT, slug, 'index.md');
      if (!fs.existsSync(mdPath)) { issues.push({ slug, type: 'no-md', msg: 'Missing index.md' }); return; }
      const raw = fs.readFileSync(mdPath, 'utf-8');
      const { data, content } = matter(raw);
      if (!data.title) issues.push({ slug, type: 'no-title', msg: 'Missing title' });
      if (!data.date) issues.push({ slug, type: 'no-date', msg: 'Missing date' });
      const photosDir = path.join(CONTENT, slug, 'photos');
      const videosDir = path.join(CONTENT, slug, 'videos');
      const hasPhotos = fs.existsSync(photosDir) && fs.readdirSync(photosDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)).length > 0;
      const hasVideos = fs.existsSync(videosDir) && fs.readdirSync(videosDir).filter(f => /\.(mp4|mov|avi|mkv)$/i.test(f)).length > 0;
      if (!data.cover && (hasPhotos || hasVideos)) issues.push({ slug, type: 'no-cover', msg: 'Has media but no cover' });
      if (!content.trim() && !hasPhotos && !hasVideos) issues.push({ slug, type: 'empty', msg: 'Empty post' });
    });
    res.json({ ok: issues.length === 0, issues, count: issues.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Category / Tag Management ======
app.get('/api/taxonomy', (req, res) => {
  try {
    const cats = {}, tags = {};
    const dirs = fs.readdirSync(CONTENT).filter(d => { try { return fs.statSync(path.join(CONTENT, d)).isDirectory() && !d.startsWith('.'); } catch { return false; } });
    dirs.forEach(slug => {
      const mdPath = path.join(CONTENT, slug, 'index.md');
      if (!fs.existsSync(mdPath)) return;
      const { data } = matter(fs.readFileSync(mdPath, 'utf-8'));
      const cat = data.category || 'uncategorized';
      if (!cats[cat]) cats[cat] = [];
      cats[cat].push(slug);
      (data.tags || []).forEach(t => { if (!tags[t]) tags[t] = []; tags[t].push(slug); });
    });
    res.json({
      categories: Object.entries(cats).map(([name, posts]) => ({ name, count: posts.length, posts })),
      tags: Object.entries(tags).map(([name, posts]) => ({ name, count: posts.length, posts })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/taxonomy/category', (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
    const dirs = fs.readdirSync(CONTENT).filter(d => { try { return fs.statSync(path.join(CONTENT, d)).isDirectory() && !d.startsWith('.'); } catch { return false; } });
    let count = 0;
    dirs.forEach(slug => {
      const mdPath = path.join(CONTENT, slug, 'index.md');
      if (!fs.existsSync(mdPath)) return;
      let raw = fs.readFileSync(mdPath, 'utf-8');
      const { data } = matter(raw);
      if (data.category === oldName) {
        raw = raw.replace(/^category:.*$/m, 'category: ' + newName);
        fs.writeFileSync(mdPath, raw);
        count++;
      }
    });
    res.json({ ok: true, renamed: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/taxonomy/tag', (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: 'oldName and newName required' });
    const dirs = fs.readdirSync(CONTENT).filter(d => { try { return fs.statSync(path.join(CONTENT, d)).isDirectory() && !d.startsWith('.'); } catch { return false; } });
    let count = 0;
    dirs.forEach(slug => {
      const mdPath = path.join(CONTENT, slug, 'index.md');
      if (!fs.existsSync(mdPath)) return;
      let raw = fs.readFileSync(mdPath, 'utf-8');
      const { data } = matter(raw);
      if ((data.tags || []).includes(oldName)) {
        raw = raw.replace(new RegExp('(tags:.*)\\\\b' + oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\\\b', 'g'), '$1' + newName);
        // Simpler: just replace the whole tags line
        const newTags = (data.tags || []).map(t => t === oldName ? newName : t);
        raw = raw.replace(/^tags:.*$/m, 'tags: [' + newTags.join(', ') + ']');
        fs.writeFileSync(mdPath, raw);
        count++;
      }
    });
    res.json({ ok: true, renamed: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Duplicate Post ======
app.post('/api/posts/:slug/duplicate', (req, res) => {
  try {
    const srcDir = path.join(CONTENT, req.params.slug);
    if (!fs.existsSync(srcDir)) return res.status(404).json({ error: 'Not found' });
    const newSlug = req.body.slug || (req.params.slug + '-copy');
    const destDir = path.join(CONTENT, newSlug);
    if (fs.existsSync(destDir)) return res.status(400).json({ error: 'Already exists: ' + newSlug });
    fs.cpSync(srcDir, destDir, { recursive: true });
    const mdPath = path.join(destDir, 'index.md');
    if (fs.existsSync(mdPath)) {
      let raw = fs.readFileSync(mdPath, 'utf-8');
      raw = raw.replace(/^title:.*$/m, 'title: "' + newSlug + '"');
      raw = raw.replace(/^date:.*$/m, 'date: ' + new Date().toISOString().split('T')[0]);
      fs.writeFileSync(mdPath, raw);
    }
    res.json({ ok: true, slug: newSlug });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Disk Usage ======
app.get('/api/disk', (req, res) => {
  try {
    const du = (dir) => {
      let size = 0;
      if (!fs.existsSync(dir)) return 0;
      fs.readdirSync(dir).forEach(f => {
        const fp = path.join(dir, f);
        if (fs.statSync(fp).isDirectory()) size += du(fp);
        else size += fs.statSync(fp).size;
      });
      return size;
    };
    const contentSize = du(CONTENT);
    const distSize = du(path.join(ROOT, 'dist'));
    res.json({ content: contentSize, dist: distSize, contentMB: (contentSize/1024/1024).toFixed(1), distMB: (distSize/1024/1024).toFixed(1) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Recent Files ======
app.get('/api/recent-files', (req, res) => {
  try {
    const files = [];
    const walk = (dir, max) => {
      if (!fs.existsSync(dir) || files.length >= max) return;
      fs.readdirSync(dir).forEach(f => {
        const fp = path.join(dir, f);
        if (f.startsWith('.') || f === 'node_modules') return;
        if (fs.statSync(fp).isDirectory()) walk(fp, max);
        else files.push({ path: path.relative(ROOT, fp).replace(/\\/g, '/'), mtime: fs.statSync(fp).mtime.toISOString() });
      });
    };
    walk(CONTENT, 20);
    walk(path.join(ROOT, 'src'), 10);
    files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(files.slice(0, 15));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====== Error handling ======
app.use((err, req, res, _next) => {
  console.error('[admin] Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal error' });
});

// ====== Request logging ======
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => console.log(`[admin] ${req.method} ${req.path} ${res.statusCode} ${Date.now()-t0}ms`));
  next();
});

// ====== Start ======
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log('Mosaic Admin running at http://localhost:' + PORT);
});
process.on('uncaughtException', (e) => console.error('[admin] Uncaught:', e));
