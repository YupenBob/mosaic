import { generateData } from '../generate-data.js';
import { generatePages } from '../generate-pages.js';

export default {
  name: 'generate',
  enabled: true,
  priority: 30,
  critical: true,
  async run(ctx) {
    const { posts, categories, tags } = await generateData(ctx.site);
    await generatePages(posts, ctx.site);
    ctx.posts = posts;
    ctx.categories = categories;
    ctx.tags = tags;
    return `${posts.length}p ${categories?.length||0}c ${tags?.length||0}t`;
  }
};
