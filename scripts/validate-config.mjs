/**
 * Validate mosaic.config.json and post frontmatter before building.
 *
 * There is exactly one source of truth for each layer:
 *   - config rules live in shared/config.mjs (`normalizeConfig`/`validateConfig`),
 *     so the generator, the Worker and this script cannot drift apart;
 *   - frontmatter rules live in shared/content-schema.mjs (frontmatter schema),
 *     shared by the build and the Worker.
 *
 * Hard failures (exit 1):
 *   - config file unreadable, not an object, or rejected by validateConfig
 *   - frontmatter schema errors (bad date/type, unsafe category/tag/name, …)
 * Soft warnings (printed, non-fatal):
 *   - cover references a file that doesn't exist in the post directory
 *   - cosmetic frontmatter (unknown block names, duplicate tags)
 *
 * Run: node scripts/validate-config.mjs  (also wired into `npm run check`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { normalizeConfig, validateConfig } from '../shared/config.mjs';
import { validateFrontmatter } from '../shared/content-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'mosaic.config.json');
const CONTENT = path.join(ROOT, 'content', 'posts');

let errors = 0;
let warnings = 0;

const fail = (msg) => {
  console.error(`  ERROR ${msg}`);
  errors++;
};
const warn = (msg) => {
  console.log(`  WARN  ${msg}`);
  warnings++;
};

// ── config: parse, normalize and validate through the shared implementation ──
let raw;
try {
  raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  fail(`mosaic.config.json unreadable: ${e.message}`);
  process.exit(1);
}
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('mosaic.config.json must be a JSON object');

let config;
try {
  config = normalizeConfig(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
} catch (e) {
  // __proto__/constructor injection is rejected by shared/config.deepMerge.
  fail(`mosaic.config.json invalid: ${e.message}`);
  process.exit(1);
}
// `requireSiteFields` asks shared/config for the site-identity checks
// (title/url/apiBase/mediaBase/language) that only the real config file must
// satisfy; normalized defaults remain valid for tests and Worker patches.
for (const message of validateConfig(config, { requireSiteFields: true })) fail(message);

// ── post frontmatter: shared schema (hard) + build-specific media hints (soft) ──
if (fs.existsSync(CONTENT)) {
  for (const dir of fs.readdirSync(CONTENT)) {
    const postPath = path.join(CONTENT, dir);
    const indexMd = path.join(postPath, 'index.md');
    if (!fs.statSync(postPath).isDirectory() || !fs.existsSync(indexMd)) continue;
    let data;
    let content;
    try {
      const parsed = matter(fs.readFileSync(indexMd, 'utf8'));
      data = parsed.data;
      content = parsed.content;
    } catch (e) {
      fail(`${dir}/index.md frontmatter parse error: ${e.message}`);
      continue;
    }

    const schema = validateFrontmatter(data, { slug: dir });
    for (const error of schema.errors) fail(`${dir}: ${error}`);
    for (const warning of schema.warnings) warn(`${dir}: ${warning}`);

    if (typeof data.cover === 'string' && data.cover && !/^video:\d+$|^photo:\d+$/.test(data.cover)) {
      const coverPath = path.join(postPath, data.cover);
      if (!fs.existsSync(coverPath)) {
        warn(`${dir}: cover "${data.cover}" not found under ${dir}/ (will be resolved by the pipeline)`);
      }
    }
    // Content-block placeholders (valid positions only: alone on a line,
    // surrounded by blank lines). Media may not be synced at validate time in
    // CI, so range checks run only when the local media directory exists.
    const photosCount = fs.existsSync(path.join(postPath, 'photos'))
      ? fs.readdirSync(path.join(postPath, 'photos')).length
      : 0;
    const videosCount = fs.existsSync(path.join(postPath, 'videos'))
      ? fs.readdirSync(path.join(postPath, 'videos')).length
      : 0;
    const knownKinds = ['gallery', 'videos', 'music', 'video', 'photo'];
    const lines = String(content || '').split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = /^\s*\{\{([a-zA-Z0-9:_-]+)\}\}\s*$/.exec(line);
      if (!m) return;
      const prevBlank = i === 0 || lines[i - 1].trim() === '';
      const nextBlank = i === lines.length - 1 || lines[i + 1].trim() === '';
      if (!prevBlank || !nextBlank) return;
      const token = m[1];
      const [kind, idxRaw] = token.split(':');
      if (!knownKinds.includes(kind)) {
        warn(`${dir}: unknown placeholder "{{${token}}}" (ignored)`);
        return;
      }
      if (kind === 'video' || kind === 'photo') {
        const idx = Number(idxRaw);
        if (idxRaw === undefined || !Number.isInteger(idx) || idx < 0) {
          warn(`${dir}: placeholder "{{${token}}}" has invalid index (ignored)`);
        } else if (kind === 'video' && videosCount > 0 && idx >= videosCount) {
          warn(`${dir}: {{video:${idx}}} out of range (${videosCount} video(s))`);
        } else if (kind === 'photo' && photosCount > 0 && idx >= photosCount) {
          warn(`${dir}: {{photo:${idx}}} out of range (${photosCount} photo(s))`);
        }
      }
    });
  }
}

console.log(`validate-config: ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors > 0 ? 1 : 0);
