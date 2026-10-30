/**
 * Post list filtering must operate on the data model, not only rendered rows.
 * Regression for the old 100-row chunk + DOM query implementation.
 */
import assert from 'node:assert/strict';
import { filterPostList } from '../cloud-admin/js/post-filter.js';

const posts = Array.from({ length: 120 }, (_, index) => ({
  slug: index === 118 ? 'needle-post' : `post-${index}`,
  title: index === 118 ? 'Needle in the haystack' : `Post ${index}`,
  category: index % 2 ? 'parent/child' : 'parent/other',
  tags: index === 118 ? ['needle'] : ['tag'],
  date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
}));
const stats = Object.fromEntries(posts.map((post, index) => [post.slug, { views: index }]));

assert.equal(filterPostList(posts, { query: 'needle' }).length, 1, 'search reaches beyond 100 posts');
assert.equal(filterPostList(posts, { query: 'needle' })[0].slug, 'needle-post');
assert.equal(filterPostList(posts, { category: 'parent' }).length, 120, 'parent category includes children');
assert.equal(filterPostList(posts, { category: 'parent/child' }).length, 60);
assert.equal(filterPostList(posts, { query: 'needle', category: 'parent' }).length, 1);
assert.equal(filterPostList(posts, { sort: 'title' })[0].title, 'Needle in the haystack', 'title sorts alphabetically');
assert.equal(filterPostList(posts, { sort: 'views', stats })[0].slug, 'post-119', 'views sorts descending');
assert.equal(
  filterPostList(posts, { sort: 'oldest' }).at(-1).date >= filterPostList(posts, { sort: 'oldest' })[0].date,
  true,
);
assert.equal(filterPostList([], { query: 'x' }).length, 0);

console.log('Post filter: 120-post search, category prefix and sorting passed');
