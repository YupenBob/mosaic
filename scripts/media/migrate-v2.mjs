/**
 * Media v2 migration CLI (dry-run by default).
 *
 *   1. read the current mixed manifest and posts
 *   2. plan deterministic asset ids + R2 copy pairs (pure planner)
 *   3. copy originals/processed objects server-side (existing targets skipped)
 *   4. import v2 assets into the Jobs DO (v1 entries stay for rollback)
 *   5. rewrite every post's frontmatter `media` block in ONE Git commit
 *
 * Apply requires both `--apply` and `MIGRATION_CONFIRM=media-v2`. Old R2 keys
 * are never deleted by this script. The single commit is built through the
 * GitHub Git Data API against the branch head captured before any I/O, so a
 * concurrent push fails the migration instead of interleaving with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { loadContext } from '../lib/context.mjs';
import { createPipelineClient } from '../lib/pipeline-client.mjs';
import { createGitDataClient } from '../lib/github-git-data.mjs';
import { createStorage } from './storage.mjs';
import { planV2Migration } from './plan-v2.mjs';
import { applyV2Migration, uniqueCopies } from './apply-v2.mjs';
import { validateAssetManifest } from '../../shared/media-v2.mjs';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const context = loadContext();
const store = createStorage(context.config);
const request = createPipelineClient();
const repo = process.env.GITHUB_REPO || process.env.GITHUB_REPOSITORY;
const branch = process.env.SITE_BRANCH || 'main';

function readPosts() {
  return fs
    .readdirSync(context.content, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = path.join(context.content, entry.name, 'index.md');
      if (!fs.existsSync(file)) return null;
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = matter(raw);
      return { slug: entry.name, frontMatter: parsed.data, body: parsed.content, file, raw };
    })
    .filter(Boolean);
}

/** Only posts whose media/cover actually change become part of the commit. */
function changedPosts(posts, plan) {
  const files = [];
  for (const entry of plan.posts) {
    const post = posts.find((candidate) => candidate.slug === entry.slug);
    if (!post) continue;
    const cover = entry.media?.cover || post.frontMatter.cover;
    const before = JSON.stringify({ media: post.frontMatter.media ?? null, cover: post.frontMatter.cover ?? null });
    const after = JSON.stringify({ media: entry.media ?? null, cover: cover ?? null });
    if (before === after) continue;
    const data = { ...post.frontMatter, media: entry.media };
    if (cover) data.cover = cover;
    const serialized = matter.stringify(post.body, data);
    if (serialized === post.raw) continue;
    files.push({ path: `content/posts/${post.slug}/index.md`, content: serialized });
  }
  return files;
}

async function main() {
  const state = await request('media/state');
  const posts = readPosts();
  const plan = await planV2Migration({ manifest: state.manifest, posts });
  const copies = uniqueCopies(plan);
  // Validate before touching R2; a bad generation/source shape must fail here.
  validateAssetManifest({
    schemaVersion: 2,
    revision: 0,
    assets: Object.fromEntries(plan.assets.map((asset) => [asset.id, asset])),
  });
  const files = changedPosts(posts, plan);
  console.log(
    `Media v2 plan: ${plan.counts.assets} assets, ${copies.length} object copies, ${plan.counts.posts} posts, ${plan.counts.references} references, ${files.length} post files to rewrite (one commit)`,
  );
  if (args.has('--write-plan')) {
    const planFile = path.join(context.root, '.mosaic/media-v2-plan.json');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, JSON.stringify({ counts: plan.counts, copies, posts: plan.posts }, null, 2));
  }
  if (!apply) {
    console.log('Dry run. Re-run with --apply and MIGRATION_CONFIRM=media-v2 to migrate.');
    return;
  }
  if (process.env.MIGRATION_CONFIRM !== 'media-v2')
    throw new Error('Set MIGRATION_CONFIRM=media-v2 to confirm the migration');
  if (files.length && !repo) throw new Error('GITHUB_REPO is required to commit the rewritten posts');
  const git = files.length ? createGitDataClient({ repo, token: process.env.GITHUB_TOKEN, branch }) : null;
  // Capture the base before copying anything: the commit must apply on exactly
  // this head or report a conflict.
  const base = git ? await git.readHead() : null;

  let copied = 0;
  const result = await applyV2Migration({
    plan,
    head: async (to) => Boolean(await store.head(to)),
    copy: async (from, to) => {
      await store.copy(from, to);
      copied++;
    },
    importAssets: (assets) => request('media/import-v2', { assets }),
    writeMarker: (value) => store.putJSON('site-data/media-v2-migration.json', value),
  });
  let commit = null;
  if (git && files.length) {
    commit = await git.commitFiles({
      files,
      message: `Migrate media to v2: ${files.length} posts [skip ci]`,
      expectedBaseSha: base.sha,
    });
  }
  console.log(
    `Copied ${copied} objects${result.skippedCopies ? ` (skipped ${result.skippedCopies} existing)` : ''}, imported ${result.assets} assets, ` +
      (commit ? `rewrote ${files.length} posts in commit ${commit.sha.slice(0, 7)}` : 'no post files changed'),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
