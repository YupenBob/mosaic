/**
 * The migration apply path is testable without credentials: copies, imports,
 * post rewrites and the completion marker are injected effects.
 */
import assert from 'node:assert/strict';
import { applyV2Migration, uniqueCopies } from '../scripts/media/apply-v2.mjs';

const plan = {
  assets: Array.from({ length: 30 }, (_, index) => ({ id: `ast_${String(index).padStart(26, '0')}` })),
  copies: [
    { from: 'originals/a/x.jpg', to: 'originals/assets/a/x.jpg' },
    { from: 'originals/a/x.jpg', to: 'originals/assets/a/x.jpg' },
    { from: '', to: 'unused' },
  ],
  posts: [{ slug: 'a', media: { gallery: ['ast_00000000000000000000000000'] } }],
  counts: { assets: 30, copies: 1, posts: 1 },
};
assert.equal(uniqueCopies(plan).length, 1);

const events = [];
const result = await applyV2Migration({
  plan,
  copy: async (from, to) => events.push(['copy', from, to]),
  importAssets: async (assets) => events.push(['import', assets.length]),
  rewritePost: async (post) => events.push(['post', post.slug]),
  writeMarker: async (value) => events.push(['marker', value.assets, value.copies, value.posts]),
});
assert.deepEqual(result, { assets: 30, copies: 1, posts: 1 });
assert.deepEqual(
  events.map((event) => event.slice(0, 2)),
  [
    ['copy', 'originals/a/x.jpg'],
    ['import', 25],
    ['import', 5],
    ['post', 'a'],
    ['marker', 30],
  ],
);

const failed = [];
await assert.rejects(
  () =>
    applyV2Migration({
      plan,
      copy: async () => {
        failed.push('copy');
        throw new Error('copy failed');
      },
      importAssets: async () => failed.push('import'),
      rewritePost: async () => failed.push('post'),
    }),
  /copy failed/,
);
assert.deepEqual(failed, ['copy'], 'a failed copy stops before imports/posts');

console.log('Migrate v2 apply: copies, batches, posts, marker and failure stop passed');
