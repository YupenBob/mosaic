/** Compatibility facade. New code imports the service it owns. */
export { listPosts, getPost, createOrUpdatePost, deletePost } from './services/content.js';
export { getConfig, updateConfig } from './services/site-config.js';
export {
  dispatchBuild,
  buildRunDetail,
  getLatestRun,
  getRunById,
  getRunHistory,
  cancelRun,
} from './services/workflows.js';
export { isDirty, markDirty, clearDirty } from './services/publication.js';
export { renameCategory, renameTag, removeCategory, removeTag } from './services/taxonomy.js';
export { bustCache } from './services/github-client.js';
