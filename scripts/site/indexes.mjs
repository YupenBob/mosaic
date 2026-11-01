import { categoryRoute, categorySegments, tagSlug } from '../../shared/taxonomy.mjs';

export function buildIndexes(posts) {
  const nodes = new Map(),
    tags = new Map();
  for (const post of posts) {
    // Validated while reading the post; this also throws when a caller hands
    // buildIndexes an unsafe taxonomy (build-time hard failure).
    const parts = categorySegments(post.category);
    parts.forEach((name, index) => {
      const full = parts.slice(0, index + 1).join('/');
      if (!nodes.has(full))
        nodes.set(full, {
          name,
          full,
          slug: categoryRoute(full),
          count: 0,
          depth: index,
          children: [],
          posts: [],
        });
      const node = nodes.get(full);
      node.count++;
      node.posts.push(post);
    });
    for (const tag of post.tags) {
      if (!tags.has(tag)) tags.set(tag, { name: tag, slug: tagSlug(tag), count: 0, posts: [] });
      tags.get(tag).count++;
      tags.get(tag).posts.push(post);
    }
  }
  for (const [full, node] of nodes) {
    const parent = full.split('/').slice(0, -1).join('/');
    if (parent) nodes.get(parent)?.children.push(node);
  }
  const categories = [...nodes.values()].filter((n) => n.depth === 0);
  const listing = posts.map(
    ({
      slug,
      title,
      date,
      category,
      tags,
      description,
      media,
      cover,
      coverLqip,
      coverAspect,
      coverSrcset,
      type,
      stats,
    }) => ({
      slug,
      title,
      date,
      category,
      tags,
      description,
      media,
      cover,
      coverLqip,
      coverAspect,
      coverSrcset,
      type,
      stats,
    }),
  );
  return { categories, tags: [...tags.values()], categoryPages: [...nodes.values()], listing };
}
