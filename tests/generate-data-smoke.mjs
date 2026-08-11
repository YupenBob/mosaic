/**
 * Generate data smoke test: structural invariants on dist/data/*.json
 * (the payload that drives the frontend), so regressions in generate.js are
 * caught at the data level instead of only "did it produce files".
 *
 * Run: node tests/generate-data-smoke.mjs  (wired into `npm run check`)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const RES_KEYS = ['4K', '1080p', '720p', '480p', '360p', '240p'];
const LAYOUTS = ['default', 'video-first', 'gallery-first'];
const VIDEO_MODES = ['stacked', 'playlist'];

function isUrl(v) {
  return typeof v === 'string' && v.length > 0 && (v.startsWith('http') || v.startsWith('/api/'));
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`);
  if (!ok) failures++;
};

console.log('\n== generate ==');
const g = spawnSync(process.execPath, ['scripts/generate.js'], { cwd: ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000 });
check('generate exits 0', g.status === 0, `status=${g.status}`);
if (g.status !== 0) console.error(g.stderr.slice(0, 2000));

const read = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIST, 'data', f), 'utf8')); }
  catch (e) { return { __error: e.message }; }
};
const posts = read('posts.json');
const categories = read('categories.json');
const tags = read('tags.json');
const search = read('search-index.json');

check('posts.json is an array', Array.isArray(posts));
check('categories.json is an array', Array.isArray(categories));
check('tags.json is an array', Array.isArray(tags));
check('search-index.json is an array', Array.isArray(search));
if (!Array.isArray(posts)) { console.log('\ngenerate-data-smoke: FAIL (no posts.json)'); process.exit(1); }

// ── Every post on disk (with index.md) must appear in posts.json ──
const contentRoot = path.join(ROOT, 'content', 'posts');
const expectedSlugs = fs.existsSync(contentRoot)
  ? fs.readdirSync(contentRoot).filter((d) => {
      try { return fs.statSync(path.join(contentRoot, d)).isDirectory() && fs.existsSync(path.join(contentRoot, d, 'index.md')); }
      catch { return false; }
    })
  : [];
const actualSlugs = posts.map((p) => p.slug);
const missing = expectedSlugs.filter((s) => !actualSlugs.includes(s));
check('all content posts appear in posts.json', missing.length === 0, missing.join(', '));

// ── Per-post invariants ──
for (const p of posts) {
  const tag = `[${p.slug}]`;
  check(`${tag} has string fields`, typeof p.title === 'string' && typeof p.date === 'string' && typeof p.category === 'string' && typeof p.description === 'string' && typeof p.bodyHTML === 'string');
  check(`${tag} tags is string array`, Array.isArray(p.tags) && p.tags.every((t) => typeof t === 'string'));
  check(`${tag} layout/videoMode valid`, LAYOUTS.includes(p.layout) && VIDEO_MODES.includes(p.videoMode));
  check(`${tag} coverAspect finite`, Number.isFinite(p.coverAspect) && p.coverAspect > 0);
  check(`${tag} stats numeric`, p.stats && Number.isFinite(p.stats.views) && Number.isFinite(p.stats.likes) && Number.isFinite(p.stats.dwell_time));

  for (const ph of p.photos || []) {
    check(`${tag} photo ${ph.base} variants`, isUrl(ph.src10p) && isUrl(ph.src480) && isUrl(ph.src720) && isUrl(ph.src1080) && isUrl(ph.srcOrig) && isUrl(ph.thumb), 'all srcs present');
  }

  for (const v of p.videos || []) {
    check(`${tag} video ${v.base} has poster`, isUrl(v.poster));
    const kinds = [!!v.hls, !!v.sources && Object.keys(v.sources).length > 0, !!v.src].filter(Boolean).length;
    check(`${tag} video ${v.base} exactly one source kind`, kinds === 1, `kinds=${kinds}`);
    if (v.sources) {
      const keys = Object.keys(v.sources);
      check(`${tag} video ${v.base} res keys valid`, keys.every((k) => RES_KEYS.includes(k)), keys.join(','));
      check(`${tag} video ${v.base} source urls valid`, keys.every((k) => isUrl(v.sources[k])));
    }
    if (v.hls) check(`${tag} video ${v.base} hls url valid`, isUrl(v.hls));
    if (v.src) check(`${tag} video ${v.base} src url valid`, isUrl(v.src));
  }

  for (const m of p.music || []) {
    check(`${tag} music ${m.file} sources`, m.sources && isUrl(m.sources['128k']) && isUrl(m.sources['320k']));
  }

  if (p.cover) check(`${tag} cover is URL`, isUrl(p.cover));
  if (p.coverSrcset) {
    check(`${tag} coverSrcset variants`, isUrl(p.coverSrcset['480']) && isUrl(p.coverSrcset['720']) && isUrl(p.coverSrcset['1080']));
  }
}

// ── No stray template tokens / undefined / NaN in critical JSON ──
const raw = JSON.stringify(posts);
check('no undefined/NaN/NaN tokens in posts.json', !/undefined|NaN/.test(raw));

// ── Category & tag counts match posts ──
for (const c of categories) {
  const n = posts.filter((p) => p.category === c.name).length;
  check(`category "${c.name}" count matches`, n === c.count, `posts=${n} declared=${c.count}`);
}
for (const t of tags) {
  const n = posts.filter((p) => (p.tags || []).includes(t.name)).length;
  check(`tag "${t.name}" count matches`, n === t.count, `posts=${n} declared=${t.count}`);
}

// ── Search index mirrors posts ──
check('search-index has same post set', search.length === posts.length && search.every((s) => actualSlugs.includes(s.slug)));

console.log(`\ngenerate-data-smoke: ${failures === 0 ? 'OK' : failures + ' failure(s)'}`);
process.exit(failures === 0 ? 0 : 1);
