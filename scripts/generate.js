/** Static-site CLI: source + Markdown + one published media snapshot. */
import { loadContext } from './lib/context.mjs';
import { generateSite } from './site/generate.mjs';
const result = generateSite(loadContext());
console.log(`Generated: ${result.posts} posts; media revision ${result.mediaRevision}`);
