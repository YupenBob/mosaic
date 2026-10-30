/**
 * Pure post list filtering/sorting. Kept out of the DOM so it can be tested
 * with hundreds of posts and reused by the command palette later.
 */

/**
 * @param {Array<object>} posts
 * @param {{query?:string, category?:string, sort?:string, stats?:object}} options
 * @returns {Array<object>}
 */
export function filterPostList(posts, { query = '', category = '', sort = 'newest', stats = {} } = {}) {
  const q = String(query || '')
    .toLowerCase()
    .trim();
  const cat = String(category || '');
  const list = (posts || []).filter((post) => {
    const haystack =
      `${post.title || ''} ${post.slug || ''} ${post.category || ''} ${(post.tags || []).join(' ')}`.toLowerCase();
    const matchesQuery = !q || haystack.includes(q);
    const matchesCategory = !cat || post.category === cat || String(post.category || '').startsWith(cat + '/');
    return matchesQuery && matchesCategory;
  });
  const value = (post, key) => {
    if (key === 'title') return String(post.title || post.slug || '').toLowerCase();
    if (key === 'views') return Number(stats[post.slug]?.views || 0);
    return post.date || '';
  };
  if (sort === 'title') list.sort((a, b) => value(a, 'title').localeCompare(value(b, 'title')));
  else if (sort === 'views') list.sort((a, b) => value(b, 'views') - value(a, 'views'));
  else {
    const direction = sort === 'oldest' ? 1 : -1;
    list.sort((a, b) => String(value(a, sort)).localeCompare(String(value(b, sort))) * direction);
  }
  return list;
}
