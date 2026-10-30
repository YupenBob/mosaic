/**
 * Media v2 migration CLI (dry-run by default).
 *
 *   1. read the current mixed manifest and posts
 *   2. plan deterministic asset ids + R2 copy pairs (pure planner)
 *   3. copy originals/processed objects server-side
 *   4. import v2 assets into the Jobs DO (v1 entries stay for rollback)
 *   5. rewrite each post's frontmatter `media` block
 *
 * Apply requires both `--apply` and `MIGRATION_CONFIRM=media-v2`. Old R2 keys
 * are never deleted by this script.
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { loadContext } from '../lib/context.mjs';
import { createPipelineClient } from '../lib/pipeline-client.mjs';
import { createStorage } from './storage.mjs';
import { planV2Migration } from './plan-v2.mjs';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const context = loadContext();
const store = createStorage(context.config);
const request = createPipelineClient();

function readPosts() {
  return fs
    .readdirSync(context.content, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = path.join(context.content, entry.name, 'index.md');
      if (!fs.existsSync(file)) return null;
      const parsed = matter(fs.readFileSync(file, 'utf8'));
      return { slug: entry.name, frontMatter: parsed.data, body: parsed.content, file };
    })
    .filter(Boolean);
}

async function github(pathname, options = {}) {
  const repo = process.env.GITHUB_REPO || process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPO is required');
  const branch = process.env.SITE_BRANCH || 'main';
  const url = `https://api.github.com/repos/${repo}/contents/${pathname}?ref=${encodeURIComponent(branch)}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Mosaic-Media-V2-Migration',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return response;
}

async function rewritePost(post, media) {
  const pathname = `content/posts/${post.slug}/index.md`;
  const current = await github(pathname);
  if (!current.ok) throw new Error(`Read ${pathname}: ${current.status}`);
  const file = await current.json();
  const parsed = matter(fs.readFileSync(post.file, 'utf8'));
  const data = { ...parsed.data, media };
  if (media.cover) data.cover = media.cover;
  const serialized = matter.stringify(parsed.content, data);
  const response = await github(pathname, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Migrate media to v2: ${post.slug}`,
      content: Buffer.from(serialized, 'utf8').toString('base64'),
      sha: file.sha,
      branch: process.env.SITE_BRANCH || 'main',
    }),
  });
  if (!response.ok) throw new Error(`Write ${pathname}: ${response.status} ${await response.text()}`);
  return pathname;
}

async function main() {
  const state = await request('media/state');
  const posts = readPosts();
  const plan = await planV2Migration({ manifest: state.manifest, posts });
  const copies = [...new Map(plan.copies.filter((copy) => copy.from).map((copy) => [copy.to, copy])).values()];
  console.log(
    `Media v2 plan: ${plan.counts.assets} assets, ${copies.length} object copies, ${plan.counts.posts} posts, ${plan.counts.references} references`,
  );
  if (args.has('--write-plan')) {
    fs.writeFileSync(
      path.join(context.root, '.mosaic/media-v2-plan.json'),
      JSON.stringify({ counts: plan.counts, copies, posts: plan.posts }, null, 2),
    );
  }
  if (!apply) {
    console.log('Dry run. Re-run with --apply and MIGRATION_CONFIRM=media-v2 to migrate.');
    return;
  }
  if (process.env.MIGRATION_CONFIRM !== 'media-v2')
    throw new Error('Set MIGRATION_CONFIRM=media-v2 to confirm the migration');

  for (const copy of copies) await store.copy(copy.from, copy.to);
  console.log(`Copied ${copies.length} objects`);

  for (let offset = 0; offset < plan.assets.length; offset += 25) {
    const assets = plan.assets.slice(offset, offset + 25);
    await request('media/import-v2', { assets });
  }
  console.log(`Imported ${plan.assets.length} v2 assets`);

  let rewritten = 0;
  for (const post of plan.posts) {
    await rewritePost(
      posts.find((candidate) => candidate.slug === post.slug),
      post.media,
    );
    rewritten++;
  }
  await store.putJSON('site-data/media-v2-migration.json', {
    completedAt: new Date().toISOString(),
    assets: plan.assets.length,
    copies: copies.length,
    posts: rewritten,
  });
  console.log(`Rewrote ${rewritten} posts; migration marker written`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
