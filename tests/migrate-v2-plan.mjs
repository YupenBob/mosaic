/**
 * Pure Media v2 migration planner: deterministic ids, R2 copy pairs and post
 * media blocks. No network or R2 access.
 */
import assert from 'node:assert/strict';
import { planV2Migration } from '../scripts/media/plan-v2.mjs';
import { validateAssetManifest } from '../shared/media-v2.mjs';
import { assetIdFromLegacy, ASSET_ID_RE } from '../shared/media-v2.mjs';

const manifest = {
  schemaVersion: 1,
  revision: 3,
  assets: {
    'post/photos/a.jpg': {
      id: 'post/photos/a.jpg',
      slug: 'post',
      filename: 'a.jpg',
      folder: 'photos',
      order: 1,
      status: 'ready',
      source: { key: 'originals/post/photos/a.jpg', etag: 'e1', available: true },
      published: { variants: { '480p': 'processed/post/photos/1/480p.jpg' } },
    },
    'post/videos/clip.mp4': {
      id: 'post/videos/clip.mp4',
      slug: 'post',
      filename: 'clip.mp4',
      folder: 'videos',
      order: 2,
      status: 'ready',
      source: { key: 'originals/post/videos/clip.mp4', etag: 'e2', available: true },
      published: {
        sources: { '480p': 'processed/post/videos/2/480p.mp4' },
        poster: 'processed/post/videos/2/poster.jpg',
      },
    },
    'post/covers/cover.jpg': {
      id: 'post/covers/cover.jpg',
      slug: 'post',
      filename: 'cover.jpg',
      folder: 'covers',
      order: 0,
      status: 'ready',
      source: { key: '', etag: '', available: false },
      published: { variants: { '480p': 'processed/post/covers/1/480p.jpg' } },
    },
  },
};
const posts = [
  { slug: 'post', frontMatter: { title: 'Post', cover: 'photo:0' } },
  {
    slug: 'already-v2',
    frontMatter: { media: { gallery: ['ast_aaaaaaaaaaaaaaaaaaaaaaaaaa'], videos: [], music: [], cover: null } },
  },
];
const plan = await planV2Migration({ manifest, posts });
assert.equal(plan.counts.assets, 3);
assert.equal(plan.counts.copies, 6);
const photo = plan.assets.find((asset) => asset.filename === 'a.jpg');
assert.match(photo.id, ASSET_ID_RE);
assert.equal(photo.id, await assetIdFromLegacy('post/photos/a.jpg'));
assert.equal(photo.v2, true);
assert.equal(photo.slug, null);
assert.equal(photo.source.key, `originals/assets/${photo.id}/a.jpg`);
assert.equal(photo.published.variants['480p'], `processed/assets/${photo.id}/legacy/1/480p.jpg`);
assert.equal(photo.legacy.id, 'post/photos/a.jpg');
const video = plan.assets.find((asset) => asset.folder === 'videos');
assert.equal(video.published.poster, `processed/assets/${video.id}/legacy/2/poster.jpg`);
const media = plan.posts.find((post) => post.slug === 'post').media;
assert.deepEqual(media.gallery, [photo.id]);
assert.deepEqual(media.videos, [video.id]);
assert.deepEqual(media.music, []);
assert.equal(media.cover, photo.id, 'photo:N cover maps to the same photo index');
assert.deepEqual(
  plan.posts.find((post) => post.slug === 'already-v2').media,
  posts[1].frontMatter.media,
  'posts already on v2 are left alone',
);
assert.ok(plan.copies.some((copy) => copy.from === 'originals/post/photos/a.jpg' && copy.to === photo.source.key));
assert.ok(
  plan.copies.some(
    (copy) =>
      copy.from === 'processed/post/videos/2/poster.jpg' &&
      copy.to === `processed/assets/${video.id}/legacy/2/poster.jpg`,
  ),
);

const cover = plan.assets.find((asset) => asset.folder === 'covers');
assert.equal(cover.source.key, `originals/assets/${cover.id}/cover.jpg`);
assert.equal(cover.source.available, false);
validateAssetManifest({
  schemaVersion: 2,
  revision: 0,
  assets: Object.fromEntries(plan.assets.map((asset) => [asset.id, asset])),
});

console.log('Migrate v2 plan: ids, copy pairs, post media and validation passed');
