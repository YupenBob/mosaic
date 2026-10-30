/**
 * Git history for the admin: list commits, inspect patches and restore files
 * through the GitHub Contents API. No database; Git is the source of truth.
 */
import { GITHUB_API, branchPayload, headers } from './github-client.js';
import { markDirty } from './publication.js';

const SHA_RE = /^[a-f0-9]{7,40}$/;
const MAX_RESTORE_FILES = 20;

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function repo(c) {
  return c.env.GITHUB_REPO;
}

async function github(c, pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `${GITHUB_API}/repos/${repo(c)}${pathname}`;
  const response = await fetch(url, {
    ...options,
    headers: { ...headers(c), ...(options.headers || {}) },
  });
  return response;
}

function mapCommit(commit) {
  return {
    sha: commit.sha,
    shortSha: commit.sha?.slice(0, 7),
    message: commit.commit?.message?.split('\n')[0] || '',
    body: commit.commit?.message || '',
    author: commit.commit?.author?.name || commit.author?.login || '',
    date: commit.commit?.author?.date || '',
    url: commit.html_url || '',
  };
}

export async function listHistory(c, limit = 30) {
  const size = Math.min(100, Math.max(1, Number(limit) || 30));
  const response = await github(
    c,
    `/commits?per_page=${size}${c.env.SITE_BRANCH ? `&sha=${encodeURIComponent(c.env.SITE_BRANCH)}` : ''}`,
  );
  if (!response.ok) throw new Error(`GitHub history: ${response.status}`);
  const data = await response.json();
  return (Array.isArray(data) ? data : []).map(mapCommit);
}

export async function getHistoryCommit(c, sha) {
  if (!SHA_RE.test(sha || ''))
    throw Object.assign(new Error('Invalid commit sha'), { status: 400, code: 'INVALID_PARAMS' });
  const response = await github(c, `/commits/${sha}`);
  if (response.status === 404) throw Object.assign(new Error('Commit not found'), { status: 404, code: 'NOT_FOUND' });
  if (!response.ok) throw new Error(`GitHub commit: ${response.status}`);
  const data = await response.json();
  return {
    ...mapCommit(data),
    files: (data.files || []).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch || '',
      binary: !!file.binary,
    })),
  };
}

async function readFile(c, pathname, ref) {
  const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const response = await github(c, `/contents/${pathname}${suffix}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Read ${pathname}: ${response.status}`);
  return response.json();
}

async function putFile(c, pathname, content, sha, message) {
  const response = await github(c, `/contents/${pathname}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: encodeBase64(content),
      ...(sha ? { sha } : {}),
      ...branchPayload(c),
    }),
  });
  if (!response.ok) throw new Error(`Restore ${pathname}: ${response.status} ${(await response.text()).slice(0, 160)}`);
  return response.json();
}

async function deleteFile(c, pathname, sha, message) {
  const response = await github(c, `/contents/${pathname}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, ...branchPayload(c) }),
  });
  if (!response.ok) throw new Error(`Delete ${pathname}: ${response.status}`);
  return response.json();
}

/**
 * Restore files from a commit. With `path`, only that file is restored.
 * Returns per-file results; failures are reported instead of aborting the whole
 * commit so one conflict doesn't leave the UI without feedback.
 */
export async function restoreHistory(c, sha, path = '') {
  const detail = await getHistoryCommit(c, sha);
  let files = detail.files;
  if (path) {
    if (!files.some((file) => file.filename === path))
      throw Object.assign(new Error('File is not part of this commit'), { status: 400, code: 'INVALID_PARAMS' });
    files = files.filter((file) => file.filename === path);
  }
  if (files.length > MAX_RESTORE_FILES)
    throw Object.assign(new Error(`Too many files (max ${MAX_RESTORE_FILES})`), { status: 400, code: 'TOO_MANY' });
  const results = [];
  for (const file of files) {
    try {
      const current = await readFile(c, file.filename);
      if (file.status === 'removed') {
        if (!current) {
          results.push({ path: file.filename, status: 'skipped' });
          continue;
        }
        await deleteFile(c, file.filename, current.sha, `Restore ${detail.shortSha}: remove ${file.filename}`);
        results.push({ path: file.filename, status: 'deleted' });
      } else {
        const original = await readFile(c, file.filename, sha);
        if (!original?.content) {
          results.push({ path: file.filename, status: 'skipped' });
          continue;
        }
        const content = decodeBase64(original.content.replace(/\s/g, ''));
        await putFile(c, file.filename, content, current?.sha, `Restore ${detail.shortSha}: ${file.filename}`);
        results.push({ path: file.filename, status: 'restored' });
      }
    } catch (error) {
      results.push({ path: file.filename, status: 'failed', error: error.message });
    }
  }
  await markDirty(c.env, '');
  return { ok: results.every((file) => file.status !== 'failed'), commit: detail.shortSha, files: results };
}
