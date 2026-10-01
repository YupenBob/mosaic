export function buildIndexes(posts) {
  const nodes = new Map(),
    tags = new Map();
  for (const post of posts) {
    const parts = post.category
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean);
    parts.forEach((name, index) => {
      const full = parts.slice(0, index + 1).join('/');
      if (!nodes.has(full))
        nodes.set(full, {
          name,
          full,
          slug: name.toLowerCase().replace(/\s+/g, '-'),
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
      if (!tags.has(tag))
        tags.set(tag, { name: tag, slug: tag.toLowerCase().replace(/\s+/g, '-'), count: 0, posts: [] });
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
    ({ slug, title, date, category, tags, description, cover, coverAspect, coverSrcset, type, stats }) => ({
      slug,
      title,
      date,
      category,
      tags,
      description,
      cover,
      coverAspect,
      coverSrcset,
      type,
      stats,
    }),
  );
  return { categories, tags: [...tags.values()], categoryPages: [...nodes.values()], listing };
}
