import { contentsUrl, branchPayload, headers, decodeBase64, encodeBase64, bustCache } from './github-client.js';
import { listPosts } from './content.js';
async function fetchRawFile(c, repoPath) {
  const resp = await fetch(contentsUrl(c, `${repoPath}`), { headers: headers(c) });
  if (!resp.ok) return null;
  const file = await resp.json();
  return { sha: file.sha, content: decodeBase64(file.content) };
}

async function putRawFile(c, repoPath, content, sha, message) {
  const resp = await fetch(contentsUrl(c, `${repoPath}`), {
    method: 'PUT',
    headers: { ...headers(c), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...branchPayload(c), message, content: encodeBase64(content), sha }),
  });
  return resp.ok;
}

export async function renameCategory(c, oldName, newName, message) {
  const posts = await listPosts(c);
  let renamed = 0;
  for (const p of posts) {
    if ((p.category || '') !== oldName) continue;
    const file = await fetchRawFile(c, `content/posts/${p.slug}/index.md`);
    if (!file) continue;
    const next = file.content.replace(/^category:.*$/m, `category: ${newName}`);
    if (next === file.content) continue;
    if (
      await putRawFile(
        c,
        `content/posts/${p.slug}/index.md`,
        next,
        file.sha,
        message || `Rename category ${oldName} to ${newName}`,
      )
    )
      renamed++;
  }
  bustCache();
  return renamed;
}

export async function renameTag(c, oldName, newName, message) {
  const posts = await listPosts(c);
  let renamed = 0;
  for (const p of posts) {
    const tags = (p.tags || []).map((t) => String(t));
    if (!tags.includes(oldName)) continue;
    const file = await fetchRawFile(c, `content/posts/${p.slug}/index.md`);
    if (!file) continue;
    const newTags = tags.map((t) => (t === oldName ? newName : t));
    const next = file.content.replace(/^tags:.*$/m, `tags: [${newTags.join(', ')}]`);
    if (next === file.content) continue;
    if (
      await putRawFile(
        c,
        `content/posts/${p.slug}/index.md`,
        next,
        file.sha,
        message || `Rename tag ${oldName} to ${newName}`,
      )
    )
      renamed++;
  }
  bustCache();
  return renamed;
}

/**
 * Remove a category from every post that uses it (posts themselves are kept).
 * Returns the number of posts that were rewritten.
 */
export async function removeCategory(c, name, message) {
  const posts = await listPosts(c);
  let affected = 0;
  for (const p of posts) {
    if ((p.category || '') !== name) continue;
    const file = await fetchRawFile(c, `content/posts/${p.slug}/index.md`);
    if (!file) continue;
    const next = file.content.replace(/^category:.*$/m, '');
    if (next === file.content) continue;
    if (await putRawFile(c, `content/posts/${p.slug}/index.md`, next, file.sha, message || `Remove category ${name}`))
      affected++;
  }
  bustCache();
  return affected;
}

/**
 * Remove a tag from every post that uses it (posts themselves are kept).
 * Returns the number of posts that were rewritten.
 */
export async function removeTag(c, name, message) {
  const posts = await listPosts(c);
  let affected = 0;
  for (const p of posts) {
    const tags = (p.tags || []).map(String);
    if (!tags.includes(name)) continue;
    const file = await fetchRawFile(c, `content/posts/${p.slug}/index.md`);
    if (!file) continue;
    const newTags = tags.filter((tag) => tag !== name);
    const next = file.content.replace(/^tags:.*$/m, newTags.length ? `tags: [${newTags.join(', ')}]` : '');
    if (next === file.content) continue;
    if (await putRawFile(c, `content/posts/${p.slug}/index.md`, next, file.sha, message || `Remove tag ${name}`))
      affected++;
  }
  bustCache();
  return affected;
}
