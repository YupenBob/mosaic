/**
 * Shared data layer — single source of truth for posts and i18n.
 * Replaces window.__POSTS / window.__I18N globals.
 */

let _posts = [];
export function setPosts(p) {
  _posts = p || [];
}
export function getPosts() {
  return _posts;
}

let _i18n = {};
let _lang = 'zh-CN';

export function initI18n(i18nData, lang) {
  _i18n = i18nData || {};
  _lang = lang || 'zh-CN';
}

export function t(key) {
  return (_i18n[key] && _i18n[key][_lang]) || (_i18n[key] && _i18n[key].en) || key;
}
