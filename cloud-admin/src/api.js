/**
 * Worker API Client — typed wrappers for all Mosaic API endpoints.
 * Handles auth token injection and auto-refresh.
 */

const API_BASE = (typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : '') || '/api';

let _token = null;

/** Get or refresh auth token */
export function getToken() {
  if (!_token) {
    try {
      _token = localStorage.getItem('mosaic_admin_token');
    } catch { /* ignore */ }
  }
  return _token;
}

export function setToken(t) {
  _token = t;
  if (t) {
    try { localStorage.setItem('mosaic_admin_token', t); } catch {}
  } else {
    try { localStorage.removeItem('mosaic_admin_token'); } catch {}
  }
}

/** Base fetch with auth header and error handling */
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (resp.status === 401) {
    // Token expired — clear and redirect to login
    setToken(null);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mosaic:auth-expired'));
    }
    throw new Error('Unauthorized');
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${resp.status}`);
  }

  return resp.json();
}

// ── Auth ───────────────────────────────────
export const auth = {
  login: (password) =>
    apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),

  refresh: () =>
    apiFetch('/auth/refresh', { method: 'POST' }),
};

// ── Posts ──────────────────────────────────
export const posts = {
  list: () => apiFetch('/posts'),

  get: (slug) => apiFetch(`/posts/${slug}`),

  create: (data) =>
    apiFetch('/posts', { method: 'POST', body: JSON.stringify(data) }),

  update: (slug, data) =>
    apiFetch(`/posts/${slug}`, { method: 'PUT', body: JSON.stringify(data) }),

  delete: (slug) =>
    apiFetch(`/posts/${slug}`, { method: 'DELETE' }),

  duplicate: (slug, newSlug) =>
    apiFetch(`/posts/${slug}/duplicate`, { method: 'POST', body: JSON.stringify({ slug: newSlug }) }),
};

// ── Media ──────────────────────────────────
export const media = {
  list: (slug) => apiFetch(`/media/${encodeURIComponent(slug)}/list`),

  delete: (slug, file, type = 'photos') =>
    apiFetch(`/media/${encodeURIComponent(slug)}/${encodeURIComponent(file)}?type=${type}`, { method: 'DELETE' }),
};

// ── Upload ─────────────────────────────────
export const upload = {
  init: (data) =>
    apiFetch('/upload/init', { method: 'POST', body: JSON.stringify(data) }),

  complete: (uploadId) =>
    apiFetch('/upload/complete', { method: 'POST', body: JSON.stringify({ uploadId }) }),

  status: (id) => apiFetch(`/upload/status/${id}`),
};

// ── Build ──────────────────────────────────
export const build = {
  status: () => apiFetch('/build/status'),

  history: () => apiFetch('/build/history'),

  trigger: () => apiFetch('/publish', { method: 'POST' }),
};

// ── Stats ──────────────────────────────────
export const stats = {
  dashboard: () => apiFetch('/stats/dashboard'),
};

// ── Config ─────────────────────────────────
export const config = {
  get: () => apiFetch('/config'),

  update: (data) => apiFetch('/config', { method: 'PUT', body: JSON.stringify(data) }),
};

// ── Taxonomy ───────────────────────────────
export const taxonomy = {
  get: () => apiFetch('/taxonomy'),
  renameCategory: (oldName, newName) =>
    apiFetch('/taxonomy/category', { method: 'PUT', body: JSON.stringify({ oldName, newName }) }),
  renameTag: (oldName, newName) =>
    apiFetch('/taxonomy/tag', { method: 'PUT', body: JSON.stringify({ oldName, newName }) }),
};

// ── Trash ──────────────────────────────────
export const trash = {
  list: () => apiFetch('/trash'),
  restore: (dir) => apiFetch(`/trash/${encodeURIComponent(dir)}/restore`, { method: 'POST' }),
  permanentDelete: (dir) => apiFetch(`/trash/${encodeURIComponent(dir)}`, { method: 'DELETE' }),
};

// ── Disk & Files ───────────────────────────
export const disk = {
  usage: () => apiFetch('/disk'),
  recentFiles: () => apiFetch('/recent-files'),
};

// ── Health ─────────────────────────────────
export const health = {
  check: () => apiFetch('/health'),
};
