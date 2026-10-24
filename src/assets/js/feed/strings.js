/**
 * Vertical-feed copy (zh/en), carried in-module on purpose so overlay-feed owns
 * its strings without appending to src/data/i18n.json (owned by Lead).
 */
const STRINGS = {
  entry: { zh: '竖屏', en: 'Feed' },
  entryLabel: { zh: '打开竖屏刷视频模式', en: 'Open vertical video feed' },
  dialogLabel: { zh: '竖屏视频', en: 'Vertical video feed' },
  close: { zh: '关闭竖屏模式', en: 'Close vertical feed' },
  play: { zh: '播放', en: 'Play' },
  pause: { zh: '暂停', en: 'Pause' },
  mute: { zh: '静音', en: 'Mute' },
  unmute: { zh: '取消静音', en: 'Unmute' },
  like: { zh: '点赞', en: 'Like' },
  unlike: { zh: '取消点赞', en: 'Unlike' },
  comment: { zh: '评论', en: 'Comments' },
  share: { zh: '分享', en: 'Share' },
  copied: { zh: '链接已复制', en: 'Link copied' },
  openPost: { zh: '查看原帖', en: 'Open post' },
  empty: { zh: '暂无可播放的视频', en: 'No videos to play yet' },
  endOfFeed: { zh: '到底啦，看完了', en: "That's all" },
  loading: { zh: '加载中…', en: 'Loading…' },
  loadFailed: { zh: '视频数据加载失败', en: 'Could not load feed data' },
  swipeHint: { zh: '上滑看下一个 · 下滑关闭', en: 'Swipe up for next · down to close' },
  progress: { zh: '播放进度', en: 'Playback progress' },
  slideOf: { zh: '第 %1 个，共 %2 个', en: 'Video %1 of %2' },
  author: { zh: '作者', en: 'Author' },
  tapHint: { zh: '单击暂停 · 双击点赞', en: 'Tap to pause · double-tap to like' },
  qualityFallback: { zh: '网络较慢，已自动降低清晰度', en: 'Slow network — switched to lower quality' },
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

/**
 * @param {keyof typeof STRINGS} key
 * @param {...(string|number)} values
 * @returns {string}
 */
export function tf(key, ...values) {
  let text = t(key);
  values.forEach((value, index) => {
    text = text.replace(`%${index + 1}`, String(value));
  });
  return text;
}
