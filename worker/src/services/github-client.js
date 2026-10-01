export const GITHUB_API = 'https://api.github.com';
export function contentsUrl(c, repoPath) {
  const url = new URL(`${GITHUB_API}/repos/${c.env.GITHUB_REPO}/contents/${repoPath}`);
  if (c.env.SITE_BRANCH) url.searchParams.set('ref', c.env.SITE_BRANCH);
  return url.href;
}
export function branchPayload(c) {
  return c.env.SITE_BRANCH ? { branch: c.env.SITE_BRANCH } : {};
}
export function headers(c) {
  return {
    Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Mosaic-Worker/1.0',
  };
}
let caches = new WeakMap();
export function cacheFor(env) {
  if (!caches.has(env)) caches.set(env, {});
  return caches.get(env);
}
export function bustCache() {
  caches = new WeakMap();
}
// ====== UTF-8 safe base64 ======

export function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ====== Helpers ======

export function parseFrontMatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  match[1].split('\n').forEach((line) => {
    const m = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (!m) return;
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
    }
    fm[m[1]] = val;
  });
  return fm;
}
