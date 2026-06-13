import { generateData } from '../generate-data.js';
import { generatePages } from '../generate-pages.js';

export default {
  name: 'generate',
  enabled: true,
  priority: 30,
  critical: true,
  async run(ctx) {
    // Pass R2 public URL and site URL through to data/page generators
    const r2PublicUrl = process.env.R2_PUBLIC_URL || ctx.site?.mediaSource?.publicUrl || '';
    const siteUrl = process.env.SITE_URL || ctx.site?.url || '';
    ctx.r2PublicUrl = r2PublicUrl;
    ctx.siteUrl = siteUrl;

    const { posts, categories, tags, searchIndex } = await generateData(ctx.site);
    await generatePages(posts, ctx.site);
    ctx.posts = posts;
    ctx.categories = categories;
    ctx.tags = tags;
    ctx.searchIndex = searchIndex;
    return `${posts.length}p ${categories?.length||0}c ${tags?.length||0}t`;
  }
};
