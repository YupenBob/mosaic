/**
 * Build Plugin Manager — loads, orders, and executes plugins.
 * Each plugin exports: { name, enabled, priority, run(ctx) }
 */
import { log, warn } from '../utils.js';

export async function runPlugins(registry, ctx) {
  // Filter enabled, sort by priority
  const plugins = registry.filter(p => p.enabled !== false).sort((a, b) => (a.priority || 100) - (b.priority || 100));
  log(`Running ${plugins.length} plugins: ${plugins.map(p => p.name).join(', ')}`);

  const results = {};
  for (const plugin of plugins) {
    const t0 = Date.now();
    try {
      results[plugin.name] = await plugin.run(ctx);
      ctx.timings.push({ name: plugin.name, ms: Date.now() - t0, detail: results[plugin.name] || '' });
    } catch (err) {
      warn(`Plugin ${plugin.name} failed: ${err.message}`);
      ctx.timings.push({ name: plugin.name + ' (ERR)', ms: Date.now() - t0, detail: err.message });
      if (plugin.critical) throw err; // Blocking error for critical plugins
    }
  }
  return results;
}
