import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadManifest } from './media.mjs';
import { readPosts } from './posts.mjs';
import { buildIndexes } from './indexes.mjs';
import { renderSite } from './render.mjs';
export function generateSite(context) {
  const manifest = loadManifest(context.manifestPath);
  const posts = readPosts(context, manifest);
  const indexes = buildIndexes(posts);
  // Reject unsafe overrides before replacing the generated output.
  const dist = path.resolve(context.dist),
    root = path.resolve(context.root);
  if (
    dist === root ||
    !dist.startsWith(root + path.sep) ||
    [context.src, context.content].some((p) => p === dist || p.startsWith(dist + path.sep))
  )
    throw new Error('Unsafe site output directory');
  fs.rmSync(dist, { recursive: true, force: true });
  const dataDir = path.join(dist, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const publicCategory = ({ posts: _posts, full: _full, ...node }) => ({
    ...node,
    children: node.children.map(publicCategory),
  });
  const publicTags = indexes.tags.map(({ posts: _posts, ...tag }) => tag);
  for (const [name, value] of Object.entries({
    'posts.json': posts,
    'posts-index.json': indexes.listing,
    'categories.json': indexes.categories.map(publicCategory),
    'tags.json': publicTags,
    'search-index.json': indexes.listing.map(({ slug, title, description, category, tags }) => ({
      slug,
      title,
      description,
      category,
      tags: tags.join(' '),
    })),
  }))
    fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value));
  renderSite(context, posts, indexes);
  const leaseFile = path.join(root, '.mosaic/build-lease.json');
  const lease = fs.existsSync(leaseFile) ? JSON.parse(fs.readFileSync(leaseFile, 'utf8')) : {};
  let gitSha = lease.gitSha || process.env.GITHUB_SHA || '';
  if (!gitSha) {
    try {
      gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {}
  }
  const snapshot = {
    schemaVersion: 1,
    gitSha,
    mediaRevision: manifest.revision,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dist, 'build-snapshot.json'), JSON.stringify(snapshot));
  if (fs.existsSync(path.join(root, 'functions')))
    fs.cpSync(path.join(root, 'functions'), path.join(dist, 'functions'), { recursive: true });
  return {
    posts: posts.length,
    mediaRevision: manifest.revision,
    listingBytes: fs.statSync(path.join(dataDir, 'posts-index.json')).size,
  };
}
