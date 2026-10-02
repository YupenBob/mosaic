/**
 * Worker API Client — typed wrappers for all Mosaic API endpoints.
 * Handles auth token injection and auto-refresh.
 */

const API_BASE = (typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : '') || '/api';

let _token = null;
let navigationSignal = null;
const readCache = new Map(),
  inFlight = new Map();
let policy = {},
  cacheRevision = 0;
export function configureClient(config = {}) {
  policy = config;
}
function invalidateReads() {
  cacheRevision++;
  readCache.clear();
}
export function setNavigationSignal(signal) {
  navigationSignal = signal;
}

/** Get or refresh auth token */
export function getToken() {
  if (!_token) {
    try {
      _token = localStorage.getItem('mosaic_admin_token');
    } catch {
      /* ignore */
    }
  }
  return _token;
}

export function setToken(t) {
  if (_token !== t) {
    invalidateReads();
    for (const entry of inFlight.values()) entry.controller.abort();
    inFlight.clear();
  }
  _token = t;
  if (t) {
    try {
      localStorage.setItem('mosaic_admin_token', t);
    } catch {}
  } else {
    try {
      localStorage.removeItem('mosaic_admin_token');
    } catch {}
  }
}

/** Base fetch with auth header and error handling */
async function performFetch(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(`${API_BASE}${path}`, {
    signal: Object.hasOwn(options, 'signal') ? options.signal || undefined : navigationSignal || undefined,
    ...options,
    headers,
  });

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
    const err = new Error(body.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.code = body.code;
    throw err;
  }

  // Surface dirty state from the response header so the banner updates instantly
  const dirtyHeader = resp.headers.get('X-Dirty');
  if (dirtyHeader && typeof window !== 'undefined') {
    const [count, last] = dirtyHeader.split('|');
    window.dispatchEvent(new CustomEvent('mosaic:dirty', { detail: { count: parseInt(count) || 0, last } }));
  }

  return resp.json();
}

/** Shared reads have independent consumers: leaving one page cannot cancel another's request. */
export function apiFetch(path, options = {}) {
  const method = options.method || 'GET';
  if (method !== 'GET') {
    const controller = new AbortController();
    const parent = Object.hasOwn(options, 'signal') ? options.signal : navigationSignal;
    const abort = () => controller.abort(parent.reason);
    if (parent?.aborted) return Promise.reject(parent.reason);
    parent?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
      policy.requestTimeoutMs ?? 15000,
    );
    return performFetch(path, { ...options, signal: controller.signal })
      .then((value) => {
        invalidateReads();
        return value;
      })
      .finally(() => {
        clearTimeout(timer);
        parent?.removeEventListener('abort', abort);
      });
  }
  const signal = Object.hasOwn(options, 'signal') ? options.signal : navigationSignal;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const ttl = path.startsWith('/build/')
    ? (policy.buildCacheMs ?? 3000)
    : /^(\/config|\/taxonomy|\/stats(?:\/.*)?|\/posts(?:\?.*)?)$/.test(path)
      ? (policy.cacheMs ?? 15000)
      : 0;
  const cached = readCache.get(path);
  if (cached && cached.expires > Date.now()) return Promise.resolve(structuredClone(cached.value));
  let entry = inFlight.get(path);
  if (!entry) {
    const controller = new AbortController(),
      revision = cacheRevision,
      token = getToken();
    entry = { controller, users: 0, done: false };
    const timer = setTimeout(
      () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
      policy.requestTimeoutMs ?? 15000,
    );
    entry.promise = performFetch(path, { ...options, signal: controller.signal })
      .then((value) => {
        if (ttl && revision === cacheRevision && token === getToken())
          readCache.set(path, { value, expires: Date.now() + ttl });
        return value;
      })
      .finally(() => {
        entry.done = true;
        clearTimeout(timer);
        if (inFlight.get(path) === entry) inFlight.delete(path);
      });
    inFlight.set(path, entry);
  }
  return new Promise((resolve, reject) => {
    entry.users++;
    let finished = false;
    const detach = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener('abort', abort);
      entry.users--;
      return true;
    };
    const abort = () => {
      if (!detach()) return;
      reject(signal.reason);
      if (!entry.users && !entry.done) {
        entry.controller.abort();
        if (inFlight.get(path) === entry) inFlight.delete(path);
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    entry.promise.then(
      (value) => {
        if (detach()) resolve(structuredClone(value));
      },
      (error) => {
        if (detach()) reject(error);
      },
    );
  });
}

// ── Auth ───────────────────────────────────
export const auth = {
  login: (password) => apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),

  refresh: () => apiFetch('/auth/refresh', { method: 'POST' }),
};

// ── Posts ──────────────────────────────────
function qs(params = {}) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export const posts = {
  list: (params) => apiFetch('/posts' + qs(params)),

  get: (slug) => apiFetch(`/posts/${slug}`),

  create: (data) => apiFetch('/posts', { method: 'POST', body: JSON.stringify(data) }),

  update: (slug, data) => apiFetch('/posts', { method: 'POST', body: JSON.stringify({ slug, ...data }) }),

  delete: (slug) => apiFetch(`/posts/${slug}`, { method: 'DELETE' }),

  duplicate: (slug, newSlug) =>
    apiFetch(`/posts/${slug}/duplicate`, { method: 'POST', body: JSON.stringify({ newSlug }) }),
};

// ── Media ──────────────────────────────────
export const media = {
  list: (slug) => apiFetch(`/media/${encodeURIComponent(slug)}/list`),

  delete: (slug, file, type = 'photos') =>
    apiFetch(`/media/${encodeURIComponent(slug)}/${encodeURIComponent(file)}?type=${type}`, { method: 'DELETE' }),
};
export const mediaJobs = {
  list: (options = {}) => apiFetch('/media-jobs', options),
  get: (id) => apiFetch(`/media-jobs/${encodeURIComponent(id)}`),
  retry: (id) => apiFetch(`/media-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  cancel: (id) => apiFetch(`/media-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
};

// ── Upload (direct to Worker → R2) ─
export const upload = {
  /** Direct upload via Worker (fallback, <=100MB) */
  directUrl: (slug, filename) =>
    `${API_BASE}/upload/direct/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`,

  /** Presigned direct-to-R2 URL (primary path — single hop, >100MB capable) */
  presign: (slug, filename, contentType) =>
    apiFetch('/upload/presign', {
      method: 'POST',
      body: JSON.stringify({ slug, filename, contentType: contentType || 'application/octet-stream' }),
    }),

  /** Multipart (resumable) upload for large files */
  multipartStart: (slug, filename, size, contentType, uploadId) =>
    apiFetch('/upload/multipart/start', {
      method: 'POST',
      body: JSON.stringify({
        slug,
        filename,
        size,
        contentType: contentType || 'application/octet-stream',
        uploadId,
      }),
    }),
  multipartParts: (slug, filename, uploadId) =>
    apiFetch('/upload/multipart/parts', {
      method: 'POST',
      body: JSON.stringify({ slug, filename, uploadId }),
    }),
  multipartComplete: (slug, filename, uploadId) =>
    apiFetch('/upload/multipart/complete', {
      signal: null,
      method: 'POST',
      body: JSON.stringify({ slug, filename, uploadId }),
    }),
  multipartAbort: (slug, filename, uploadId) =>
    apiFetch('/upload/multipart/abort', {
      method: 'POST',
      body: JSON.stringify({ slug, filename, uploadId }),
    }),

  /** Confirm a presigned upload landed in R2 (marks the site dirty) */
  complete: (slug, filename) =>
    apiFetch(`/upload/complete/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`, {
      method: 'POST',
      signal: null,
    }),
};

// ── Build ──────────────────────────────────
export const build = {
  status: (options = {}) => apiFetch('/build/status', options),

  /** Compatibility probe; deployment acknowledgement is reserved for the signed pipeline. */
  done: (body = {}) => apiFetch('/build/done', { method: 'POST', body: JSON.stringify(body) }),

  /** Cancel the currently running build. */
  cancel: () => apiFetch('/build/cancel', { method: 'POST' }),

  history: () => apiFetch('/build/history'),

  /** Single build run detail (metadata + step timeline) by GitHub run id. */
  run: (id) => apiFetch(`/build/run/${encodeURIComponent(id)}`),

  trigger: () => apiFetch('/build', { method: 'POST' }),

  progress: () => apiFetch('/build/progress').catch(() => null),
};

// ── Stats ──────────────────────────────────
export const stats = {
  dashboard: () => apiFetch('/stats'),
  traffic: () => apiFetch('/stats/traffic'),
  posts: () => apiFetch('/stats/posts').catch(() => ({ stats: {} })),
};

// ── Config ─────────────────────────────────
export const config = {
  get: (options = {}) => apiFetch('/config', options),

  update: (data) => apiFetch('/config', { method: 'PUT', body: JSON.stringify(data) }),
};

// ── Taxonomy ───────────────────────────────
export const taxonomy = {
  get: () => apiFetch('/taxonomy'),
  renameCategory: (oldName, newName) =>
    apiFetch('/taxonomy/category', { method: 'PUT', body: JSON.stringify({ oldName, newName }) }),
  renameTag: (oldName, newName) =>
    apiFetch('/taxonomy/tag', { method: 'PUT', body: JSON.stringify({ oldName, newName }) }),
  removeCategory: (name) => apiFetch('/taxonomy/category', { method: 'DELETE', body: JSON.stringify({ name }) }),
  removeTag: (name) => apiFetch('/taxonomy/tag', { method: 'DELETE', body: JSON.stringify({ name }) }),
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
};

// ── Health ─────────────────────────────────
export const health = {
  check: () => apiFetch('/health'),
  github: () => apiFetch('/health/github'),
  r2: () => apiFetch('/health/r2'),
};
