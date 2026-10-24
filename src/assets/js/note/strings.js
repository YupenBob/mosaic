/**
 * Note-modal copy (zh/en). Carried in-module on purpose: the overlay-feed
 * workflow owns its strings and must not require i18n.json keys from another
 * owner. Key style mirrors src/data/i18n.json ({ zh, en }).
 */
const STRINGS = {
  close: { zh: '关闭详情', en: 'Close note' },
  loading: { zh: '加载中…', en: 'Loading…' },
  loadFailed: { zh: '笔记加载失败，正在打开原帖…', en: 'Could not load note — opening the post…' },
  views: { zh: '浏览', en: 'Views' },
  likes: { zh: '点赞', en: 'Likes' },
  dwell: { zh: '阅读', en: 'Read' },
  like: { zh: '点赞', en: 'Like' },
  unlike: { zh: '取消点赞', en: 'Unlike' },
  shared: { zh: '链接已复制', en: 'Link copied' },
  shareTitle: { zh: '分享', en: 'Share' },
  openPost: { zh: '查看原帖', en: 'Open post' },
  prevPhoto: { zh: '上一张', en: 'Previous photo' },
  nextPhoto: { zh: '下一张', en: 'Next photo' },
  playVideo: { zh: '播放视频', en: 'Play video' },
  openPostToPlay: { zh: '到原帖播放', en: 'Play on post page' },
  music: { zh: '音乐', en: 'Music' },
  unknownNote: { zh: '未找到该笔记', en: 'Note not found' },
  photoAlt: { zh: '图片', en: 'Photo' },
  dialogLabel: { zh: '笔记详情', en: 'Note details' },
  confirmCopy: { zh: '复制链接', en: 'Copy link' },
};

function lang() {
  const code = window.__LANG || document.documentElement.lang || 'zh-CN';
  return String(code).toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * @param {keyof typeof STRINGS} key
 * @returns {string}
 */
export function t(key) {
  const entry = STRINGS[key];
  if (!entry) return key;
  return entry[lang()] || entry.zh || key;
}
