import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const CONTENT_DIR = path.join(ROOT, 'content', 'posts');
export const DIST_DIR = path.join(ROOT, 'dist');
export const SRC_DIR = path.join(ROOT, 'src');
export const ASSETS_DIR = path.join(SRC_DIR, 'assets');
export const THEMES_DIR = path.join(ROOT, 'themes');
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

/**
 * Convert a local media path to an R2 public URL.
 * If R2_PUBLIC_URL is set, media paths are rewritten to point to R2.
 */
export function r2MediaUrl(postSlug, type, file) {
  if (R2_PUBLIC_URL) {
    return `${R2_PUBLIC_URL}/processed/${postSlug}/${type}/${file}`;
  }
  // Fallback: relative path for local development
  return `media/${type}/${file}`;
}

export function log(msg) { console.log(`[mosaic] ${msg}`); }
export function warn(msg) { console.warn(`[mosaic] WARN: ${msg}`); }
export function error(msg) { console.error(`[mosaic] ERR: ${msg}`); }

export async function ensureDir(dir) {
  await fs.ensureDir(dir);
}

export async function copyDir(src, dest) {
  await fs.copy(src, dest);
}

export async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export function getMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

export async function readJSON(p) {
  try { return await fs.readJSON(p); } catch { return null; }
}

export async function writeJSON(p, data) {
  await fs.writeJSON(p, data, { spaces: 2 });
}

export async function readFile(p) {
  return await fs.readFile(p, 'utf-8');
}

export async function writeFile(p, content) {
  await fs.outputFile(p, content);
}

/**
 * Process items with a concurrency limit
 */
export async function asyncPool(concurrency, items, fn) {
  const results = [];
  const executing = new Set();
  for (const [i, item] of items.entries()) {
    const p = Promise.resolve().then(() => fn(item, i));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

/**
 * Compute composite score
 */
export function computeScore(views, likes, dwellTime) {
  return (views || 0) + (dwellTime || 0) + (likes || 0) * 10;
}
