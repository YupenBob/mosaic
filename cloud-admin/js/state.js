/**
 * Shared application state (leaf module — import from anywhere).
 */
export const state = {
  page: '',
  params: {},
  authStatus: 'checking', // 'checking' | 'ok' | 'expired'
  abortController: null,
  posts: [],
  postStats: {},       // slug -> { views, likes }
  siteUrl: '',
  mediaBase: window.__MEDIA_BASE__ || '/api/media/file',
  config: {},
  editorDirty: false,
  editorDraftKey: null,
};
