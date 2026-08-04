/**
 * Validate mosaic.config.json and post frontmatter before building.
 *
 * Hard failures (exit 1):
 *   - config missing required fields or wrong types
 *   - frontmatter date not parseable / category not a string / tags not an array
 * Soft warnings (printed, non-fatal):
 *   - cover references a file that doesn't exist in the post directory
 *
 * Run: node scripts/validate-config.mjs  (also wired into `npm run check`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

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

// ── config shape ──
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  fail(`mosaic.config.json unreadable: ${e.message}`);
  process.exit(1);
}

for (const key of ['title', 'url', 'apiBase', 'mediaBase', 'language']) {
  if (typeof cfg[key] !== 'string' || !cfg[key]) fail(`config.${key} must be a non-empty string`);
}
if (cfg.pageSize !== undefined && (typeof cfg.pageSize !== 'number' || cfg.pageSize < 1)) {
  fail('config.pageSize must be a positive number');
}
for (const q of ['imageQuality', 'videoQuality']) {
  if (cfg[q] !== undefined && (typeof cfg[q] !== 'object' || cfg[q] === null)) {
    fail(`config.${q} must be an object`);
  }
}
for (const group of ['plugins', 'components']) {
  if (cfg[group] !== undefined && (typeof cfg[group] !== 'object' || cfg[group] === null)) {
    fail(`config.${group} must be an object`);
  }
}

// ── post frontmatter ──
if (fs.existsSync(CONTENT)) {
  for (const dir of fs.readdirSync(CONTENT)) {
    const postPath = path.join(CONTENT, dir);
    const indexMd = path.join(postPath, 'index.md');
    if (!fs.statSync(postPath).isDirectory() || !fs.existsSync(indexMd)) continue;
    let data;
    try {
      data = matter(fs.readFileSync(indexMd, 'utf8')).data;
    } catch (e) {
      fail(`${dir}/index.md frontmatter parse error: ${e.message}`);
      continue;
    }
    if (data.date !== undefined && Number.isNaN(new Date(data.date).getTime())) {
      fail(`${dir}: date "${data.date}" is not parseable`);
    }
    if (data.category && typeof data.category !== 'string') {
      fail(`${dir}: category must be a string`);
    }
    if (data.tags !== undefined && (!Array.isArray(data.tags) || data.tags.some((t) => typeof t !== 'string'))) {
      fail(`${dir}: tags must be an array of strings`);
    }
    if (typeof data.cover === 'string' && data.cover && !/^video:\d+$|^photo:\d+$/.test(data.cover)) {
      const coverPath = path.join(postPath, data.cover);
      if (!fs.existsSync(coverPath)) {
        warn(`${dir}: cover "${data.cover}" not found under ${dir}/ (will be resolved by the pipeline)`);
      }
    }
  }
}

console.log(`validate-config: ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors > 0 ? 1 : 0);
