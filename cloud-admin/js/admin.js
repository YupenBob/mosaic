/**
 * Mosaic Cloud Admin — rewritten with proper SPA architecture
 * - AbortController cancels stale page loads (no more race conditions)
 * - Auth checked once at startup, no flash
 * - Clean page lifecycle with mount/unmount
 */
import { auth, posts as postsApi, media as mediaApi, upload, build, stats, config, taxonomy, trash, disk, health, track } from '../src/api.js';
import { getToken, setToken } from '../src/api.js';

// ── i18n ────────────────────────────────────
const I18N = {
  'zh-CN': {
    login: { title: 'Mosaic 管理后台', subtitle: '请输入管理员密码', placeholder: '密码', btn: '登录', signing: '登录中...', error: '登录失败' },
    nav: { dashboard: '仪表盘', posts: '文章', editor: '编辑器', build: '构建与部署', config: '站点设置', taxonomy: '分类与标签', cleanup: '清理', signOut: '退出登录' },
    dashboard: {
      title: '仪表盘', healthy: '所有系统正常', issues: '存在异常',
      posts: '文章', categories: '分类', tags: '标签', totalViews: '总浏览量', r2Usage: 'R2 存储',
      newPost: '新建文章', buildDeploy: '构建并部署', viewSite: '访问网站',
      traffic: '流量（30天）', catTag: '分类 & 标签', leaderboard: '排行榜 · 热门文章', recentActivity: '最近动态', noData: '暂无数据', noActivity: '暂无动态',
      updated: '更新了',
    },
    posts: { title: '文章', search: '搜索文章...', allCats: '全部分类', newPost: '新建', delete: '删除', uncategorized: '未分类' },
    editor: {
      title: '编辑器', newPost: '新建文章', save: '保存',
      slug: '标识符', title: '标题', date: '日期', category: '分类', tags: '标签', description: '描述', layout: '布局', cover: '封面', views: '浏览数', likes: '点赞数', body: '正文',
      catHint: '用 / 分隔多级分类，如 photography/nature',
      upload: '上传媒体', uploadHint: '拖拽文件到此处，或点击选择', uploading: '处理中...', done: '完成', existingMedia: '已有媒体', noMedia: '还没有上传文件，使用上方上传区域', loadMedia: '加载媒体中...', loadError: '无法加载媒体',
      triggerBuild: '触发构建中...', buildQueued: '构建已加入队列',
      buildFailed: '构建触发失败', filesUploaded: '文件已上传，构建后生效',
      saveFailed: '保存失败', deleteMedia: '删除',
    },
    build: {
      title: '构建与部署', trigger: '构建并部署', refresh: '刷新',
      running: '运行中', queued: '等待中', success: '成功', failed: '失败', cancelled: '已取消', skipped: '已跳过', unknown: '未知',
      branch: '分支', commit: '提交', event: '触发方式', time: '时间',
      history: '构建历史', noBuild: '还没有构建记录', noBuildHint: '上传媒体到文章后触发第一次构建', viewOnGitHub: '在 GitHub 查看',
      alreadyRunning: '构建正在进行中',
      triggerFailed: '构建触发失败',
    },
    config: {
      title: '站点设置', save: '保存设置', saved: '设置已保存', saveFailed: '保存失败',
      general: '基本信息', author: '作者信息', theme: '主题与布局', media: '媒体画质', features: '功能开关', giscus: 'Giscus 评论', plugins: '生成插件',
      siteTitle: '站点标题', siteTitleHint: '浏览器标签页和页头显示',
      subtitle: '副标题', subtitleHint: '标题下方的简短描述',
      desc: '站点描述', descHint: 'SEO 用，会出现在搜索引擎结果里',
      url: '站点网址', urlHint: '完整的 URL，如 https://example.com',
      lang: '界面语言', langHint: '前台页面的默认语言',
      favicon: '网站图标', faviconHint: '浏览器标签页上的小图标路径',
      dateFmt: '日期格式', dateFmtHint: '如 YYYY-MM-DD',
      authorName: '作者名', authorNameHint: '显示在文章署名和 RSS 中',
      email: '邮箱', emailHint: 'RSS feed 用到，可不填',
      theme: '主题配色', themeHint: '前台颜色模式',
      pageSize: '每页文章数', pageSizeHint: '首页和列表页每页显示多少篇',
      galleryThresh: '画廊阈值', galleryThreshHint: '少于这个数量的图片用单列大图展示',
      cardTags: '卡片显示标签', cardTagsHint: '文章卡片上是否显示标签',
      cardStats: '卡片显示统计', cardStatsHint: '文章卡片上是否显示浏览/点赞数',
      footer: '页脚文字', footerHint: '留空则不显示页脚',
      imgQuality: '图片压缩质量', imgQualityHint: '数值越大画质越好，文件越大（1-100）',
      videoQuality: '视频压缩参数', videoQualityHint: 'CRF 越小画质越好体积越大，preset 越快压缩速度越快',
      busuanzi: '不蒜子统计', busuanziHint: '第三方访客计数',
      videoCompress: '视频压缩', videoCompressHint: '上传视频时自动转码 HLS',
      searchMin: '搜索最少字数', searchMinHint: '输入多少个字后触发搜索',
      compSwitch: '组件开关', compSwitchHint: '控制前台各模块是否加载',
      gallery: '图片画廊', galleryHint: '点击图片放大查看',
      video: '视频播放器', videoHint: '自定义视频播放控件',
      comments: '评论系统', commentsHint: 'Giscus 评论区',
      search: '搜索功能', searchHint: '全站文章搜索',
      likes: '点赞按钮', likesHint: '文章点赞互动',
      stats: '停留统计', statsHint: '记录阅读时长',
      giscusHint: '在 giscus.app 配置后获取以下参数',
      giscusRepo: 'GitHub 仓库', giscusRepoHint: '如 username/repo',
      giscusRepoId: 'Repo ID', giscusRepoIdHint: '安装 Giscus 后获得',
      giscusCat: '分类名', giscusCatHint: '存放评论的 Discussion 分类',
      giscusCatId: 'Category ID', giscusCatIdHint: '分类的 ID',
      imgCompress: '图片压缩', imgCompressHint: '构建时自动压缩图片为 WebP',
      videoCompressPlugin: '视频压缩', videoCompressPluginHint: '构建时自动转码视频为 HLS',
      rss: 'RSS 订阅', rssHint: '生成 RSS/Atom feed',
      sitemap: '网站地图', sitemapHint: '生成 sitemap.xml 给搜索引擎',
      themeAuto: '自动（跟随系统）', themeLight: '浅色', themeDark: '深色',
      adminLang: '后台语言', adminLangHint: '管理后台的界面语言',
    },
    taxonomy: { title: '分类与标签', categories: '分类', tags: '标签', none: '暂无', rename: '重命名' },
    cleanup: {
      title: 'R2 清理', orphan: '孤儿文件清理', orphanDesc: '属于已删除文章的文件，可以安全删除',
      orphanFiles: '个孤立文件', wastedSpace: '浪费空间', deleteOrphans: '删除所有孤儿文件', noOrphans: '一切干净！没有孤儿文件',
      cacheCleanup: '缓存清理', cacheDesc: '删除所有 processed/ 缓存文件（压缩后的媒体）。原始文件保留，下次构建时会重新生成。',
      clearCache: '清除压缩缓存',
      deleting: '删除中...', deletingCache: '删除缓存中...',
    },
    common: {
      error: '错误', delete: '删除', cancel: '取消', confirm: '确认', save: '保存', loading: '加载中...',
      deletePost: '确定要删除"{slug}"吗？这将永久删除该文章及其在 R2 中的所有媒体文件。',
      deleteOrphan: '删除所有孤儿 R2 文件？此操作不可撤销，以上列出的所有文件将永久删除。',
      deleteCache: '清除所有压缩缓存？这将删除全部 processed/ 文件。原始文件保留，下次构建时重新生成。不可撤销。',
      deleteAll: '全部删除',
      deleted: '已删除 {count} 个文件，释放 {size}',
      permDelete: '永久删除"{dir}"？此操作不可撤销。',
      renameCat: '重命名分类', renameTag: '重命名标签',
      renameFrom: '将"{old}"重命名为：',
      renamed: '已重命名 {old} → {new}',
      renameFailed: '重命名失败',
      restoreFailed: '恢复失败',
    },
  },
  'en': {
    login: { title: 'Mosaic Admin', subtitle: 'Enter your admin password', placeholder: 'Password', btn: 'Sign In', signing: 'Signing in...', error: 'Login failed' },
    nav: { dashboard: 'Dashboard', posts: 'Posts', editor: 'Editor', build: 'Build', config: 'Settings', taxonomy: 'Taxonomy', cleanup: 'Cleanup', signOut: 'Sign Out' },
    dashboard: {
      title: 'Dashboard', healthy: 'All systems healthy', issues: 'Issues detected',
      posts: 'Posts', categories: 'Categories', tags: 'Tags', totalViews: 'Total Views', r2Usage: 'R2',
      newPost: 'New Post', buildDeploy: 'Build & Deploy', viewSite: 'View Site',
      traffic: 'Traffic (30 days)', catTag: 'Categories & Tags', leaderboard: 'Leaderboard · Top Posts', recentActivity: 'Recent Activity', noData: 'No data yet', noActivity: 'No recent activity',
      updated: 'updated',
    },
    posts: { title: 'Posts', search: 'Search posts...', allCats: 'All categories', newPost: 'New', delete: 'Delete', uncategorized: 'Uncategorized' },
    editor: {
      title: 'Editor', newPost: 'New Post', save: 'Save',
      slug: 'Slug', title: 'Title', date: 'Date', category: 'Category', tags: 'Tags', description: 'Description', layout: 'Layout', cover: 'Cover', views: 'Views', likes: 'Likes', body: 'Body',
      catHint: 'Use / for multi-level, e.g. photography/nature',
      upload: 'Upload Media', uploadHint: 'Drag & drop files here, or click to select', uploading: 'Processing...', done: 'Done', existingMedia: 'Existing Media', noMedia: 'No media yet. Use the upload zone above.', loadMedia: 'Loading media...', loadError: 'Could not load media',
      triggerBuild: 'Triggering build...', buildQueued: 'Build queued', buildFailed: 'Build trigger failed', filesUploaded: 'Files uploaded. Site will update after build.',
      saveFailed: 'Save failed', deleteMedia: 'Delete',
    },
    build: {
      title: 'Build & Deploy', trigger: 'Build & Deploy', refresh: 'Refresh',
      running: 'Running', queued: 'Queued', success: 'Success', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped', unknown: 'Unknown',
      branch: 'Branch', commit: 'Commit', event: 'Event', time: 'Time',
      history: 'Build History', noBuild: 'No Builds Yet', noBuildHint: 'Upload media to a post and trigger your first build.', viewOnGitHub: 'View on GitHub',
      alreadyRunning: 'Build already in progress',
      triggerFailed: 'Build trigger failed',
    },
    config: {
      title: 'Site Configuration', save: 'Save', saved: 'Config saved!', saveFailed: 'Save failed',
      general: 'General', author: 'Author', theme: 'Theme & Layout', media: 'Media Quality', features: 'Features', giscus: 'Giscus Comments', plugins: 'Plugins',
      siteTitle: 'Site Title', siteTitleHint: 'Shown in browser tab and header',
      subtitle: 'Subtitle', subtitleHint: 'Short description below the title',
      desc: 'Description', descHint: 'Used for SEO, appears in search results',
      url: 'Site URL', urlHint: 'Full URL, e.g. https://example.com',
      lang: 'Language', langHint: 'Default language for the site frontend',
      favicon: 'Favicon', faviconHint: 'Browser tab icon path',
      dateFmt: 'Date Format', dateFmtHint: 'e.g. YYYY-MM-DD',
      authorName: 'Author Name', authorNameHint: 'Shown in bylines and RSS',
      email: 'Email', emailHint: 'Used in RSS feed, optional',
      theme: 'Theme', themeHint: 'Frontend color mode',
      pageSize: 'Posts Per Page', pageSizeHint: 'How many posts per page',
      galleryThresh: 'Gallery Threshold', galleryThreshHint: 'Fewer than this uses single-column large images',
      cardTags: 'Show Tags on Cards', cardTagsHint: 'Display tag chips on post cards',
      cardStats: 'Show Stats on Cards', cardStatsHint: 'Display view/like counts on post cards',
      footer: 'Footer Text', footerHint: 'Leave blank to hide footer',
      imgQuality: 'Image Quality', imgQualityHint: 'Higher = better quality, larger files (1-100)',
      videoQuality: 'Video Quality', videoQualityHint: 'Lower CRF = better quality, faster preset = quicker compression',
      busuanzi: 'Busuanzi Analytics', busuanziHint: 'Third-party visitor counter',
      videoCompress: 'Video Compression', videoCompressHint: 'Auto-transcode videos to HLS on upload',
      searchMin: 'Search Min Chars', searchMinHint: 'Characters needed to trigger search',
      compSwitch: 'Component Toggles', compSwitchHint: 'Enable/disable frontend modules',
      gallery: 'Photo Gallery', galleryHint: 'Click-to-zoom image viewer',
      video: 'Video Player', videoHint: 'Custom video playback controls',
      comments: 'Comments', commentsHint: 'Giscus comment section',
      search: 'Search', searchHint: 'Full-site article search',
      likes: 'Like Button', likesHint: 'Post like interaction',
      stats: 'Reading Stats', statsHint: 'Track reading time',
      giscusHint: 'Configure at giscus.app first, then fill in:',
      giscusRepo: 'GitHub Repo', giscusRepoHint: 'e.g. username/repo',
      giscusRepoId: 'Repo ID', giscusRepoIdHint: 'From Giscus setup',
      giscusCat: 'Category', giscusCatHint: 'Discussion category for comments',
      giscusCatId: 'Category ID', giscusCatIdHint: 'Category ID from Giscus',
      imgCompress: 'Image Compression', imgCompressHint: 'Auto-compress images to WebP on build',
      videoCompressPlugin: 'Video Compression', videoCompressPluginHint: 'Auto-transcode videos to HLS on build',
      rss: 'RSS Feed', rssHint: 'Generate RSS/Atom feed',
      sitemap: 'Sitemap', sitemapHint: 'Generate sitemap.xml for search engines',
      themeAuto: 'Auto (follow system)', themeLight: 'Light', themeDark: 'Dark',
      adminLang: 'Admin Language', adminLangHint: 'Language for the admin panel UI',
    },
    taxonomy: { title: 'Categories & Tags', categories: 'Categories', tags: 'Tags', none: 'None', rename: 'Rename' },
    cleanup: {
      title: 'R2 Cleanup', orphan: 'Orphan Cleanup', orphanDesc: 'Files belonging to deleted posts. Safe to delete.',
      orphanFiles: 'orphaned files', wastedSpace: 'Wasted Space', deleteOrphans: 'Delete All Orphans', noOrphans: 'All clean! No orphan files.',
      cacheCleanup: 'Cache Cleanup', cacheDesc: 'Delete all processed/ cached files. Originals are kept. Files regenerate on next build.',
      clearCache: 'Clear Processed Cache',
      deleting: 'Deleting...', deletingCache: 'Deleting cache...',
    },
    common: {
      error: 'Error', delete: 'Delete', cancel: 'Cancel', confirm: 'Confirm', save: 'Save', loading: 'Loading...',
      deletePost: 'Delete "{slug}"? This will permanently delete the post and all its media from R2.',
      deleteOrphan: 'Delete all orphaned R2 files? This cannot be undone.',
      deleteCache: 'Clear all processed cache? This deletes all processed/ files. Originals are kept. Cannot be undone.',
      deleteAll: 'Delete All',
      deleted: 'Deleted {count} files, freed {size}',
      permDelete: 'Permanently delete "{dir}"? This cannot be undone.',
      renameCat: 'Rename category', renameTag: 'Rename tag',
      renameFrom: 'Rename "{old}" to:',
      renamed: 'Renamed {old} → {new}',
      renameFailed: 'Rename failed',
      restoreFailed: 'Restore failed',
    },
  },
};

function t(path, vars = {}) {
  const lang = localStorage.getItem('mosaic_admin_lang') || 'zh-CN';
  let s = path.split('.').reduce((o, k) => o?.[k], I18N[lang]) || path.split('.').reduce((o, k) => o?.[k], I18N['zh-CN']) || path;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

function setLang(lang) {
  localStorage.setItem('mosaic_admin_lang', lang);
  // Re-render current page
  const raw = location.hash.replace('#', '') || 'dashboard';
  const [page, ...rest] = raw.split('&');
  const params = Object.fromEntries(new URLSearchParams(rest.join('&')));
  navigateTo(page, params);
  // Update static i18n elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

// ── Dirty banner (driven by Worker) ─────────
function showDirtyBanner(count, last) {
  const b = document.getElementById('dirty-banner');
  if (!b) return;
  const ago = last ? formatTime(last) : '';
  b.innerHTML = `<i class="ri-error-warning-line"></i> ${count} 项未构建的更改${ago ? '，最后修改 ' + ago : ''}。点击此处触发构建 <i class="ri-arrow-right-line"></i>`;
  b.style.display = 'block';
}
function hideDirtyBanner() {
  const b = document.getElementById('dirty-banner');
  if (b) b.style.display = 'none';
}
async function checkDirty() {
  const API = window.__API_BASE__ || '/api';
  const token = getToken();
  if (!token) return;
  try {
    const resp = await fetch(API + '/dirty', { headers: { Authorization: 'Bearer ' + token } });
    if (resp.ok) {
      const dirty = await resp.json();
      if (dirty.count > 0) showDirtyBanner(dirty.count, dirty.last);
      else hideDirtyBanner();
    }
  } catch {}
}

// ── State ──────────────────────────────────
const state = {
  page: '',
  params: {},
  authStatus: 'checking', // 'checking' | 'ok' | 'expired'
  abortController: null,
  posts: [],
  mediaBase: window.__MEDIA_BASE__ || '/api/media/file',
};

// ── Router ─────────────────────────────────
function onHashChange() {
  const raw = location.hash.replace('#', '') || 'dashboard';
  const [page, ...rest] = raw.split('&');
  const params = Object.fromEntries(new URLSearchParams(rest.join('&')));
  navigateTo(page, params);
}

function navigateTo(page, params = {}) {
  if (state.abortController) state.abortController.abort();
  state.abortController = new AbortController();
  state.page = page;
  state.params = params;
  updateNav(page);
  renderPage(page, state.abortController.signal);
}

function updateNav(page) {
  document.querySelectorAll('.nav-item[data-page]').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page);
  });
}

window.addEventListener('hashchange', onHashChange);
window.addEventListener('mosaic:auth-expired', () => { showLogin(); });

// ── Auth ───────────────────────────────────
function showLogin() {
  state.authStatus = 'expired';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  setToken(null);
}

// ── Toast notifications ────────────────────
function toast(msg, type='info', duration=5000) {
  let container = document.querySelector('.toast-container');
  if (!container) { container = document.createElement('div'); container.className = 'toast-container'; document.body.appendChild(container); }
  const icons = { success: 'ri-check-line', error: 'ri-close-line', info: 'ri-information-line' };
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.innerHTML = '<span class="toast-icon"><i class="' + icons[type] + '"></i></span><span class="toast-msg">' + msg + '</span><span class="toast-close"><i class="ri-close-line"></i></span>';
  el.querySelector('.toast-close').addEventListener('click', () => dismiss());
  container.appendChild(el);
  const dismiss = () => { el.classList.add('toast-out'); setTimeout(() => el.remove(), 200); };
  if (duration > 0) setTimeout(dismiss, duration);
}

window.mosaicLogin = async function() {
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  if (!password) { errorEl.style.display = 'block'; errorEl.textContent = t('login.error'); return; }

  btn.disabled = true;
  btn.innerHTML = '<i class="ri-loader-4-line" style="animation:spin 1s linear infinite"></i> ' + t('login.signing');
  errorEl.style.display = 'none';

  try {
    const { token } = await auth.login(password);
    setToken(token);
    state.authStatus = 'ok';
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    onHashChange();
  } catch (err) {
    errorEl.style.display = 'block';
    errorEl.textContent = t('login.error') + ': ' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = t('login.btn');
  }
};

window.mosaicLogout = function() { showLogin(); };

// ── Render engine ──────────────────────────
const mainEl = () => document.getElementById('main-content');

async function renderPage(page, signal) {
  const m = mainEl();
  if (!m) return;
  // Show skeleton first, fall back to spinner
  const skel = pages[page]?.skeleton;
  m.innerHTML = skel ? skel() : '<div style="text-align:center;padding:60px;color:var(--color-text-tertiary)"><i class="ri-loader-4-line" style="font-size:24px;animation:spin 1s linear infinite"></i></div>';

  const renderer = pages[page];
  if (!renderer) { if (!signal.aborted) m.innerHTML = '<h1>404</h1><p>Page not found</p>'; return; }

  try {
    const result = await renderer(signal);
    if (signal.aborted) return;
    m.innerHTML = typeof result === 'string' ? result : result.html;
    if (result?.onMount && !signal.aborted) result.onMount();
  } catch (err) {
    if (signal.aborted) return;
    m.innerHTML = `<h1>Error</h1><p class="error">${err.message}</p>`;
  }
}

// ── Page renderers ─────────────────────────
const pages = {};

pages.dashboard = async (signal) => {
  // Timeout helper — fast fail slow API calls so the page renders quickly
  const quick = (p, fallback, ms = 15000) => Promise.race([p.catch(() => fallback), new Promise(r => setTimeout(() => r(fallback), ms))]);
  const timedOut = () => ({ _timeout: true });
  const [dashData, healthData, trafficData, healthGithub, healthR2, diskData, cfg] = await Promise.all([
    quick(stats.dashboard(), { posts: '...', categories: '...', tags: '...' }),
    quick(health.check(), { status: 'error' }),
    quick(stats.traffic(), { total: '...', posts: '...', byDay: [], byCategory: [], byTag: [], top5: [] }, 20000),
    quick(health.github(), { status: 'error' }),
    quick(health.r2(), { status: 'error' }),
    quick(disk.usage(), { sizeMB: '...', objects: '...', cost: '...' }),
    quick(config.get(), {}),
  ]);
  if (signal.aborted) return '';

  if (cfg.mediaBase) state.mediaBase = cfg.mediaBase;
  const siteUrl = cfg.url || '';
  const today = new Date().toISOString().slice(0, 10);
  const todayViews = (trafficData.byDay || []).find(d => d.date === today)?.count || 0;
  const weekViews = (trafficData.byDay || []).slice(-7).reduce((s, d) => s + d.count, 0);

    // Build recent activity feed
    const activities = [];
    const postResult = await quick(postsApi.list(), { posts: [] }, 20000);
    const postList = postResult.posts || postResult || [];
    postList.slice(0, 5).forEach(p => {
      if (p.date) activities.push({ icon: 'ri-article-line', text: escHtml(p.title || p.slug) + ' ' + t('dashboard.updated'), time: p.date });
    });
    // Latest build
    try {
      const bs = await quick(build.status().catch(() => null), null, 5000);
      if (bs && bs.createdAt) activities.push({ icon: 'ri-tools-line', text: 'Build #' + (bs.runNumber || '?') + ' ' + (bs.conclusion || bs.status), time: bs.createdAt });
    } catch {}

    activities.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    const allHealthy = healthData.status === 'ok' && healthGithub.status === 'ok' && healthR2.status === 'ok';

  return {
    html: `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <h1 style="margin:0">${t('dashboard.title')}</h1>
        <span style="padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600;background:${allHealthy?'rgba(46,204,113,0.1)':'rgba(231,76,60,0.1)'};color:${allHealthy?'#2ecc71':'#e74c3c'}">
          <i class="${allHealthy ? 'ri-check-line' : 'ri-close-line'}"></i> ${allHealthy ? t('dashboard.healthy') : t('dashboard.issues')}
        </span>
      </div>

      <!-- Big numbers -->
      <div class="dash-cards">
        <div class="dash-big-card">
          <span class="dash-big-num">${dashData.posts || 0}</span>
          <span class="dash-big-label">${t('dashboard.posts')}</span>
        </div>
        <div class="dash-big-card">
          <span class="dash-big-num">${dashData.categories || 0}</span>
          <span class="dash-big-label">${t('dashboard.categories')}</span>
        </div>
        <div class="dash-big-card">
          <span class="dash-big-num">${dashData.tags || 0}</span>
          <span class="dash-big-label">${t('dashboard.tags')}</span>
        </div>
        <div class="dash-big-card" style="--accent:#9b59b6">
          <span class="dash-big-num">${trafficData.total || 0}</span>
          <span class="dash-big-label">${t('dashboard.totalViews')}</span>
        </div>
        <div class="dash-big-card">
          <span class="dash-big-num">${diskData.sizeMB || '0'} MB</span>
          <span class="dash-big-label">${t('dashboard.r2Usage')} · ${diskData.objects||0} obj · $${diskData.cost||'0'}/mo</span>
        </div>
      </div>

      <!-- Actions -->
      <div style="display:flex;gap:10px;margin-bottom:20px">
        <button class="btn-primary" onclick="location.hash='editor'" style="padding:10px 20px;font-size:14px"><i class="ri-add-line"></i> ${t('dashboard.newPost')}</button>
        <button class="btn-secondary" onclick="doTriggerBuild()" style="padding:10px 20px;font-size:14px"><i class="ri-play-fill"></i> ${t('dashboard.buildDeploy')}</button>
        ${siteUrl ? `<a href="${siteUrl}" target="_blank" class="btn-secondary" style="padding:10px 20px;text-decoration:none;font-size:14px"><i class="ri-external-link-line"></i> ${t('dashboard.viewSite')}</a>` : ''}
      </div>

      <!-- Charts row -->
      <div class="dash-charts">
        <div class="dash-chart-card">
          <h3>${t('dashboard.traffic')}</h3>
          <div class="dash-chart-wrap"><canvas id="chart-traffic"></canvas></div>
        </div>
        <div class="dash-chart-card">
          <h3>${t('dashboard.catTag')}</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div class="dash-chart-wrap" style="height:200px"><canvas id="chart-categories"></canvas></div>
            <div class="dash-chart-wrap" style="height:200px"><canvas id="chart-tags"></canvas></div>
          </div>
        </div>
      </div>

      <!-- Bottom row -->
      <div class="dash-bottom">
        <div class="dash-chart-card">
          <h3>${t('dashboard.leaderboard')}</h3>
          ${(trafficData.top5 || []).length ? trafficData.top5.map((t, i) => `
            <a href="#editor&slug=${encodeURIComponent(t.slug)}" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--color-border-light);font-size:13px;text-decoration:none;color:inherit">
              <span style="font-weight:700;color:${i===0?'#f0a500':i===1?'#86868b':i===2?'#cd7f32':'var(--color-text-tertiary)'};min-width:20px">#${i+1}</span>
              <span style="flex:1">${escHtml(t.title || t.slug)}</span>
              <span style="font-weight:600;color:var(--color-accent)">${t.count} views</span>
            </a>`).join('') : `<p style="color:var(--color-text-tertiary);padding:8px 0">${t('dashboard.noData')}</p>`}
        </div>
        <div class="dash-chart-card"><h3>${t('dashboard.recentActivity')}</h3>
          ${activities.length ? activities.slice(0, 8).map(a => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--color-border-light);font-size:13px">
              <i class="${a.icon}" style="color:var(--color-text-tertiary);font-size:14px"></i>
              <span style="flex:1">${a.text}</span>
              <span style="color:var(--color-text-tertiary);font-size:11px">${formatTime(a.time)}</span>
            </div>`).join('') : `<p style="color:var(--color-text-tertiary);padding:8px 0">${t('dashboard.noActivity')}</p>`}
        </div>
      </div>
    `,
    onMount() {
      const dayLabels = (trafficData.byDay || []).map(d => d.date.slice(5));
      const dayData = (trafficData.byDay || []).map(d => d.count);
      const catLabels = (trafficData.byCategory || []).map(c => c.name);
      const catData = (trafficData.byCategory || []).map(c => c.count);
      const tagLabels = (trafficData.byTag || []).map(t => t.name);
      const tagData = (trafficData.byTag || []).map(t => t.count);
      const noData = (id) => { const el = document.getElementById(id); if (el) el.parentElement.innerHTML = '<div style=\"text-align:center;padding:40px;color:var(--color-text-tertiary)\"><i class=\"ri-bar-chart-line\" style=\"font-size:32px\"></i><p style=\"margin-top:8px\">No data yet</p></div>'; };
      if (dayData.some(v => v > 0)) makeChart('chart-traffic', 'line', dayLabels, dayData, '#4361ee'); else noData('chart-traffic');
      if (catData.some(v => v > 0)) makeChart('chart-categories', 'doughnut', catLabels, catData, ['#4361ee','#2ecc71','#f0a500','#9b59b6','#e74c3c','#1abc9c','#3498db','#e67e22','#95a5a6','#34495e']); else noData('chart-categories');
      if (tagLabels.length && tagData.some(v => v > 0)) makeChart('chart-tags', 'doughnut', tagLabels, tagData, ['#4361ee','#2ecc71','#f0a500','#9b59b6','#e74c3c','#1abc9c','#3498db','#e67e22','#95a5a6','#34495e']); else noData('chart-tags');
    }
  };
};

function makeChart(id, type, labels, data, colors) {
  const canvas = document.getElementById(id);
  if (!canvas || !labels.length) return;
  new Chart(canvas, {
    type,
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: Array.isArray(colors) ? colors : colors + '33',
        borderColor: colors,
        borderWidth: type === 'line' ? 2 : 1,
        fill: type === 'line',
        tension: 0.3,
        pointRadius: type === 'line' ? 2 : 0,
        pointHoverRadius: 4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: type === 'doughnut' ? { display: true, position: 'right', labels: { boxWidth: 10, font: { size: 11 } } } : { display: false } },
      scales: type !== 'doughnut' ? {
        x: { display: type === 'bar' },
        y: { beginAtZero: true, ticks: { precision: 0 } }
      } : {}
    }
  });
}

pages.dashboard.skeleton = () => `
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
    <div class="skeleton skeleton-line" style="width:100px;height:28px;margin:0"></div>
    <div class="skeleton skeleton-line" style="width:140px;height:24px;border-radius:12px;margin:0"></div>
  </div>
  <div class="dash-cards">
    ${[1,2,3,4,5].map(() => `<div class="dash-big-card skeleton-card"><div class="skeleton skeleton-big-num"></div><div class="skeleton skeleton-big-label"></div></div>`).join('')}
  </div>
  <div style="display:flex;gap:10px;margin-bottom:20px">
    <div class="skeleton skeleton-line" style="width:110px;height:36px;border-radius:6px"></div>
    <div class="skeleton skeleton-line" style="width:140px;height:36px;border-radius:6px"></div>
  </div>
  <div class="dash-charts">
    <div class="dash-chart-card"><div class="skeleton skeleton-line w40" style="height:18px"></div><div class="skeleton skeleton-chart"></div></div>
    <div class="dash-chart-card"><div class="skeleton skeleton-line w40" style="height:18px"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div class="skeleton skeleton-chart"></div><div class="skeleton skeleton-chart"></div></div></div>
  </div>
  <div class="dash-bottom">
    <div class="dash-chart-card skeleton-card"><div class="skeleton skeleton-line w40" style="height:18px"></div>${[1,2,3].map(() => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0"><div class="skeleton skeleton-circle" style="width:20px;height:20px;min-width:20px"></div><div class="skeleton skeleton-line" style="flex:1"></div><div class="skeleton skeleton-line" style="width:60px"></div></div>`).join('')}</div>
    <div class="dash-chart-card skeleton-card"><div class="skeleton skeleton-line w40" style="height:18px"></div>${[1,2,3].map(() => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0"><div class="skeleton skeleton-circle" style="width:20px;height:20px;min-width:20px"></div><div class="skeleton skeleton-line" style="flex:1"></div><div class="skeleton skeleton-line" style="width:60px"></div></div>`).join('')}</div>
  </div>
`;

pages.posts = async (signal) => {
  const result = await postsApi.list();
  if (signal.aborted) return '';
  const postsData = result.posts || result;
  state.posts = postsData;
  return {
    html: `
      <div class="page-header">
        <h1>${t('posts.title')} (${postsData.length})</h1>
        <div style="display:flex;gap:8px">
          <div class="view-toggle">
            <button class="view-toggle-btn active" data-view="table" onclick="switchPostsView('table')"><i class="ri-list-check"></i></button>
            <button class="view-toggle-btn" data-view="cards" onclick="switchPostsView('cards')"><i class="ri-layout-grid-line"></i></button>
          </div>
          <button class="btn-primary" onclick="location.hash='editor'"><i class="ri-add-line"></i> ${t('posts.newPost')}</button>
        </div>
      </div>
      <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">
        <input type="text" id="post-search" placeholder="${t('posts.search')}" style="flex:1;min-width:200px;max-width:320px;padding:8px;border:1px solid var(--color-border);border-radius:6px"
          oninput="filterPosts(this.value)" />
        <select id="post-cat-filter" onchange="filterPostsByCat(this.value)" style="padding:8px;border:1px solid var(--color-border);border-radius:6px;font-size:13px">
          <option value="">${t('posts.allCats')}</option>
          ${buildCatOptions(postsData)}
        </select>
      </div>
      <div id="posts-table-view">
        <table class="data-table" id="posts-table">
          <thead><tr><th>Title</th><th>Category</th><th>Tags</th><th>Date</th><th></th></tr></thead>
          <tbody>
          ${postsData.map(p => `
            <tr data-search="${(p.title||'') + ' ' + (p.category||'') + ' ' + (p.tags||[]).join(' ')}" data-cat="${escHtml(p.category||'')}">
              <td><a href="#editor&slug=${encodeURIComponent(p.slug)}" style="font-weight:500;color:var(--color-text);text-decoration:none">${escHtml(p.title || p.slug)} <small style="color:var(--color-text-tertiary);font-weight:400">${escHtml(p.slug)}</small></a></td>
              <td>${escHtml(p.category || '')}</td>
              <td>${(p.tags || []).map(t => '#' + escHtml(t)).join(' ')}</td>
              <td style="font-size:12px;color:var(--color-text-tertiary)">${p.date ? p.date.split('T')[0] : ''}</td>
              <td>
                <button onclick="location.hash='editor&slug=${encodeURIComponent(p.slug)}'" class="btn-sm"><i class="ri-edit-line"></i></button>
                <button onclick="doDeletePost('${escHtml(p.slug)}')" class="btn-sm" style="color:#e74c3c"><i class="ri-delete-bin-line"></i></button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div id="posts-cards-view" style="display:none">
        <div class="admin-card-grid">
          ${postsData.map(p => `
            <a href="#editor&slug=${encodeURIComponent(p.slug)}" class="admin-post-card" data-search="${(p.title||'') + ' ' + (p.category||'') + ' ' + (p.tags||[]).join(' ')}" data-cat="${escHtml(p.category||'')}">
              ${(p.cover && !p.cover.startsWith('video:') && !p.cover.startsWith('photo:')) ? `<div class="admin-card-cover"><img src="${state.mediaBase}/processed/${encodeURIComponent(p.slug)}/covers/cover-480p.webp" alt="${escHtml(p.title)}" loading="lazy" onerror="this.parentElement.style.display='none'" /></div>` : '<div class="admin-card-cover admin-card-cover-empty"><i class="ri-article-line" style="font-size:32px;color:var(--color-text-tertiary)"></i></div>'}
              <div class="admin-card-body">
                <span class="admin-card-cat">${escHtml((p.category || 'Uncategorized').split('/').pop())}</span>
                <h3 class="admin-card-title">${escHtml(p.title || p.slug)}</h3>
                ${p.description ? `<p class="admin-card-desc">${escHtml(p.description)}</p>` : ''}
                <div class="admin-card-tags">${(p.tags || []).slice(0, 5).map(t => '#' + escHtml(t)).join(' ')}</div>
              </div>
              <div class="admin-card-footer">
                <span>${p.date ? p.date.split('T')[0] : ''}</span>
                <span class="admin-card-actions" onclick="event.preventDefault()">
                  <button onclick="event.preventDefault();doDeletePost('${escHtml(p.slug)}')" class="btn-sm" style="color:#e74c3c;font-size:11px">Delete</button>
                </span>
              </div>
            </a>`).join('')}
        </div>
      </div>
    `,
    onMount() {
      // Restore saved view preference
      const savedView = localStorage.getItem('mosaic_posts_view') || 'table';
      switchPostsView(savedView, true);
    }
  };
};
pages.posts.skeleton = () => `
  <div class="page-header"><div class="skeleton skeleton-line" style="width:120px;height:28px"></div></div>
  <div class="skeleton skeleton-line" style="width:300px;height:32px;margin-bottom:12px;border-radius:6px"></div>
  <div class="skeleton-card">${[1,2,3,4,5].map(() => `<div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--color-border-light)"><div class="skeleton skeleton-line" style="flex:2"></div><div class="skeleton skeleton-line" style="flex:1"></div><div class="skeleton skeleton-line" style="flex:1"></div><div class="skeleton skeleton-line" style="width:80px"></div></div>`).join('')}</div>
`;

pages.editor = async (signal) => {
  const slug = state.params.slug || '';
  let post = { slug: '', frontMatter: {}, body: '' };
  if (slug) {
    try { post = await postsApi.get(slug); } catch { /* new post */ }
  }
  if (signal.aborted) return '';

  const fm = post.frontMatter || {};
  const layouts = ['default', 'video-first', 'gallery-first', 'music-first'];

  return {
    html: `
      <div class="page-header">
        <h1>${slug ? escHtml(fm.title || slug) : t('editor.newPost')}</h1>
        <div style="display:flex;gap:8px">
          <button class="btn-primary" onclick="doSavePost()"><i class="ri-save-line"></i> ${t('editor.save')}</button>
        </div>
      </div>
      <div class="editor-layout">
        <div class="editor-fields">
          <label>${t('editor.slug')} <input type="text" id="fm-slug" value="${escHtml(slug)}" ${slug ? 'readonly' : ''} /></label>
          <label>${t('editor.title')} <input type="text" id="fm-title" value="${escHtml(fm.title || '')}" /></label>
          <label>${t('editor.date')} <input type="date" id="fm-date" value="${fm.date || new Date().toISOString().split('T')[0]}" /></label>
          <label>${t('editor.category')} <input type="text" id="fm-category" value="${escHtml(fm.category || '')}" placeholder="photography/nature" /><small style="color:var(--color-text-tertiary)">${t('editor.catHint')}</small></label>
          <label>${t('editor.tags')} <input type="text" id="fm-tags" value="${(fm.tags || []).join(', ')}" /></label>
          <label>${t('editor.description')} <textarea id="fm-desc" rows="2">${escHtml(fm.description || '')}</textarea></label>
          <label>${t('editor.layout')} <select id="fm-layout">${layouts.map(l => `<option value="${l}" ${fm.layout === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>${t('editor.cover')} <input type="text" id="fm-cover" value="${escHtml(fm.cover || '')}" placeholder="cover.jpg or video:0 or photo:0" /></label>
        <label>${t('editor.views')} <input type="number" id="fm-views" value="${fm.views||0}" /></label>
        <label>${t('editor.likes')} <input type="number" id="fm-likes" value="${fm.likes||0}" /></label>
        </div>
        <div class="editor-body">
          <textarea id="fm-body" style="width:100%;height:400px;font-family:var(--font-mono);font-size:14px;padding:12px;border:1px solid var(--color-border);border-radius:6px">${escHtml(post.body || '')}</textarea>
        </div>
      </div>
      <div class="editor-media" style="margin-top:20px">
        <h3>Upload Media</h3>
        <div class="upload-zone" id="upload-zone">
          <i class="ri-upload-cloud-2-line" style="font-size:32px;color:#4361ee"></i>
          <p>Drag & drop files here, or click to select</p>
          <input type="file" id="editor-media-input" multiple accept="image/*,video/*,audio/*" style="display:none" />
        </div>
        <div id="upload-progress" style="margin-top:8px"></div>
        <div id="existing-media" style="margin-top:16px"></div>
      </div>
    `,
    onMount() {
      if (slug) loadExistingMedia(slug);
    }
  };
};
pages.editor.skeleton = () => `
  <div class="page-header"><div class="skeleton skeleton-line" style="width:100px;height:28px"></div></div>
  <div class="editor-layout">
    <div class="editor-fields skeleton-card">${[1,2,3,4,5,6,7,8].map(() => `<div class="skeleton skeleton-line" style="margin-bottom:12px"></div>`).join('')}</div>
    <div class="editor-body skeleton-card"><div class="skeleton skeleton-box" style="height:300px"></div></div>
  </div>
`;

pages.build = async (signal) => {
  let statusData = null, historyData = { runs: [] };
  try {
    [statusData, historyData] = await Promise.all([
      build.status().catch(() => null),
      build.history().catch(() => ({ runs: [] })),
    ]);
  } catch {}
  if (signal.aborted) return '';

  const runs = historyData.runs || [];
  const latest = statusData && statusData.status !== 'unknown' ? statusData : runs[0] || null;

  return {
    html: `
      <div class="page-header">
        <h1>${t('build.title')}</h1>
        <div style="display:flex;gap:8px">
          <button class="btn-primary" onclick="doTriggerBuild()"><i class="ri-play-fill"></i> ${t('build.trigger')}</button>
          <button class="btn-secondary" onclick="location.reload()"><i class="ri-refresh-line"></i></button>
        </div>
      </div>
      <div id="build-status-card">${latest ? renderStatusCard(latest) : renderEmptyState()}</div>
      ${runs.length > 0 ? `<div id="build-history">${renderRunHistory(runs)}</div>` : ''}
    `,
    onMount() {
      // Local 1s ticker for running build duration
      let durTicker;
      const tickDur = () => {
        const el = document.getElementById('build-duration');
        if (!el) return;
        const start = el.dataset.start;
        const status = el.dataset.status;
        if (!start) return;
        const sec = Math.floor((Date.now() - new Date(start).getTime()) / 1000);
        if (status === 'in_progress' || status === 'queued') {
          el.textContent = '已耗时 ' + fmtDuration(sec);
        }
      };
      durTicker = setInterval(tickDur, 1000);

      let pollTimer;
      const poll = async () => {
        try {
          const s = await build.status();
          const card = document.getElementById('build-status-card');
          if (card && s && s.status !== 'unknown') {
            card.innerHTML = renderStatusCard(s);
          }
          // If build is no longer running, stop polling
          if (s && s.status !== 'in_progress' && s.status !== 'queued') {
            clearInterval(pollTimer);
            // Refresh history
            const h = await build.history().catch(() => ({ runs: [] }));
            const histEl = document.getElementById('build-history');
            if (histEl) histEl.innerHTML = (h.runs || []).length > 0 ? renderRunHistory(h.runs) : '';
          }
        } catch {}
      };
      pollTimer = setInterval(poll, 5000);
      // Cleanup on page leave
      const cleanup = () => { clearInterval(pollTimer); clearInterval(durTicker); };
      window.addEventListener('hashchange', cleanup, { once: true });
    }
  };
};

function renderStatusCard(run) {
  const statusDef = getStatusDef(run.status, run.conclusion);
  const time = formatTime(run.createdAt);
  const dur = buildDuration(run);
  const durLabel = (run.status === 'in_progress' || run.status === 'queued') ? '已耗时 ' : '用时 ';
  return `
    <div style="background:var(--color-surface);border:1px solid var(--color-border-light);border-radius:10px;padding:20px 24px;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div style="width:12px;height:12px;border-radius:50%;background:${statusDef.color};${run.status === 'in_progress' ? 'animation:pulse 1.5s infinite' : ''}"></div>
        <span style="font-size:18px;font-weight:600">
          #${run.runNumber || '—'}
          ${run.displayTitle ? ' — ' + escHtml(run.displayTitle) : ''}
        </span>
        <span style="padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;background:${statusDef.bg};color:${statusDef.color}">
          ${statusDef.label}
        </span>
        ${dur ? `<span id="build-duration" data-start="${run.createdAt}" data-status="${run.status}" style="font-size:12px;color:var(--color-text-tertiary)">${durLabel}${fmtDuration(dur)}</span>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;font-size:13px;color:var(--color-text-secondary)">
        <div><span style="color:var(--color-text-tertiary)">Branch</span><br><span style="font-family:var(--font-mono)">${escHtml(run.headBranch || 'main')}</span></div>
        <div><span style="color:var(--color-text-tertiary)">Commit</span><br><span style="font-family:var(--font-mono)">${escHtml(run.headSha || '—')}</span></div>
        <div><span style="color:var(--color-text-tertiary)">Event</span><br>${escHtml(run.event || 'push')}</div>
        <div><span style="color:var(--color-text-tertiary)">Time</span><br>${time}</div>
      </div>
      ${run.commitMessage ? `<div style="margin-top:10px;font-size:13px;color:var(--color-text-secondary)">${escHtml(run.commitMessage)}</div>` : ''}
      ${run.steps?.length ? `
        <div style="margin-top:12px;border-top:1px solid var(--color-border-light);padding-top:10px">
          <div style="font-size:12px;color:var(--color-text-tertiary);margin-bottom:6px">Progress (${run.steps.length} steps active)</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">
            ${run.steps.map(s => `<span style="padding:3px 8px;border-radius:4px;font-size:11px;background:${s.status==='in_progress'?'rgba(240,165,0,0.15)':'var(--color-surface-hover)'};color:${s.status==='in_progress'?'#f0a500':'var(--color-text-tertiary)'};border:1px solid var(--color-border-light)">${escHtml(s.name)}</span>`).join('')}
          </div>
        </div>` : ''}
      ${run.htmlUrl ? `
        <a href="${run.htmlUrl}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;margin-top:12px;font-size:13px;color:var(--color-accent);text-decoration:none">
          View on GitHub <i class="ri-external-link-line"></i>
        </a>` : ''}
    </div>
  `;
}

function renderRunHistory(runs) {
  return `
    <h2 style="margin-bottom:12px">${t('build.history')}</h2>
    <div style="display:flex;flex-direction:column;gap:2px">
      ${runs.map((r, i) => {
        const s = getStatusDef(r.status, r.conclusion);
        const time = formatTime(r.createdAt);
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:${i === 0 ? 'var(--color-surface)' : 'transparent'};border-radius:6px;font-size:13px;border:1px solid ${i === 0 ? 'var(--color-border-light)' : 'transparent'}">
            <span style="font-family:var(--font-mono);font-weight:600;min-width:48px">#${r.runNumber}</span>
            <span style="padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600;background:${s.bg};color:${s.color};min-width:70px;text-align:center">${s.label}</span>
            <span style="flex:1;color:var(--color-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(r.displayTitle || r.commitMessage || '')}</span>
            ${(()=>{const d=buildDuration(r);return d?`<span style="font-size:11px;color:var(--color-text-tertiary);min-width:60px;text-align:right">用时 ${fmtDuration(d)}</span>`:'';})()}
            <span style="font-family:var(--font-mono);font-size:11px;color:var(--color-text-tertiary);min-width:56px;text-align:right">${escHtml(r.headSha || '')}</span>
            <span style="font-size:11px;color:var(--color-text-tertiary);min-width:80px;text-align:right">${time}</span>
            ${r.htmlUrl ? `<a href="${r.htmlUrl}" target="_blank" class="btn-sm" style="text-decoration:none">View details <i class="ri-external-link-line"></i></a>` : ''}
          </div>`;
      }).join('')}
    </div>
  `;
}

function renderEmptyState() {
  return `
    <div style="text-align:center;padding:48px 24px;background:var(--color-surface);border:2px dashed var(--color-border);border-radius:10px;margin-bottom:20px">
      <i class="ri-tools-line" style="font-size:48px;color:var(--color-text-tertiary)"></i>
      <h2 style="margin:12px 0 4px">${t('build.noBuild')}</h2>
      <p style="color:var(--color-text-secondary);margin-bottom:16px">${t('build.noBuildHint')}</p>
      <button class="btn-primary" onclick="doTriggerBuild()"><i class="ri-play-fill"></i> ${t('build.trigger')}</button>
    </div>
  `;
}

function getStatusDef(status, conclusion) {
  if (status === 'in_progress' || status === 'queued') return { label: status === 'queued' ? 'Queued' : 'Running', color: '#f0a500', bg: 'rgba(240,165,0,0.12)' };
  if (conclusion === 'success') return { label: 'Success', color: '#2ecc71', bg: 'rgba(46,204,113,0.12)' };
  if (conclusion === 'failure') return { label: 'Failed', color: '#e74c3c', bg: 'rgba(231,76,60,0.12)' };
  if (conclusion === 'cancelled') return { label: 'Cancelled', color: '#6e6e73', bg: 'rgba(110,110,115,0.12)' };
  if (conclusion === 'skipped') return { label: 'Skipped', color: '#6e6e73', bg: 'rgba(110,110,115,0.12)' };
  return { label: status || 'Unknown', color: '#86868b', bg: 'rgba(134,134,139,0.1)' };
}

function buildCatOptions(postsData) {
  const tree = {};
  for (const p of postsData) {
    if (!p.category) continue;
    const parts = p.category.split('/');
    let node = tree;
    let path = '';
    for (const part of parts) {
      const name = part.trim();
      if (!name) continue;
      path += (path ? '/' : '') + name;
      if (!node[name]) node[name] = { _path: path };
      node = node[name];
    }
  }
  function render(node, depth) {
    return Object.entries(node)
      .filter(([k]) => !k.startsWith('_'))
      .map(([name, info]) => {
        const hasChildren = Object.keys(info).some(k => !k.startsWith('_'));
        return `<option value="${escHtml(info._path)}">${'&nbsp;&nbsp;'.repeat(depth)}${depth > 0 ? '└ ' : ''}${escHtml(name)}</option>` +
          (hasChildren ? render(info, depth + 1) : '');
      }).join('');
  }
  return render(tree, 0);
}

function fmtDuration(sec) {
  if (!sec || sec < 0) return '';
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return m + 'm ' + s + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm ' + s + 's';
}
function buildDuration(run) {
  if (!run.createdAt) return '';
  const start = new Date(run.createdAt).getTime();
  const end = run.status === 'in_progress' || run.status === 'queued'
    ? Date.now() : (run.updatedAt ? new Date(run.updatedAt).getTime() : Date.now());
  return Math.floor((end - start) / 1000);
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

pages.build.skeleton = () => `
  <div class="page-header"><div class="skeleton skeleton-line" style="width:140px;height:28px"></div></div>
  <div class="skeleton-card"><div class="skeleton skeleton-line w40" style="height:18px;margin-bottom:12px"></div>${['branch','commit','event','time'].map(() => `<div class="skeleton skeleton-line" style="margin-bottom:6px"></div>`).join('')}</div>
  <div class="skeleton-card">${[1,2,3].map(() => `<div style="display:flex;gap:12px;padding:8px 0;align-items:center"><div class="skeleton skeleton-line" style="width:50px"></div><div class="skeleton skeleton-line" style="width:60px"></div><div class="skeleton skeleton-line" style="flex:1"></div></div>`).join('')}</div>
`;

pages.config = async (signal) => {
  let cfg = {};
  try { cfg = await config.get(); } catch {}
  if (signal.aborted) return '';

  return {
    html: `
      <div class="page-header"><h1>Site Configuration</h1><button class="btn-primary" onclick="doSaveConfig()"><i class="ri-save-line"></i> Save</button></div>
      <div class="config-grid">
        ${sec('<i class="ri-information-line"></i> 基本信息',
          `<div class="config-field">
            <label class="config-label"><span>网站图标</span><small>浏览器标签页上的小图标，支持 SVG/PNG/ICO，最大 100KB</small></label>
            <div style="display:flex;align-items:center;gap:10px">
              <img id="favicon-preview" src="${escHtml(cfgGet(cfg, 'favicon') || '/assets/logo.svg')}" style="width:32px;height:32px;border-radius:4px;border:1px solid var(--color-border);object-fit:contain" onerror="this.style.display='none'" />
              <input type="file" id="favicon-upload-input" accept=".svg,.png,.ico,image/svg+xml,image/png,image/x-icon" style="display:none" onchange="uploadFavicon(this)" />
              <button type="button" class="btn-secondary" onclick="document.getElementById('favicon-upload-input').click()" style="font-size:12px;padding:5px 10px"><i class="ri-upload-2-line"></i> 上传新图标</button>
            </div>
            <input type="hidden" data-config="favicon" id="favicon-value" value="${escHtml(cfgGet(cfg, 'favicon'))}" />
          </div>` +
          txt('title', '站点标题', '浏览器标签页和页头显示', cfg) +
          txt('subtitle', '副标题', '标题下方的简短描述', cfg) +
          area('description', '站点描述', 'SEO 用，会出现在搜索引擎结果里', cfg) +
          txt('url', '站点网址', '完整的 URL，如 https://example.com', cfg, 'url') +
          txt('apiBase', 'Worker API 地址', 'Cloudflare Worker 的完整 URL', cfg, 'url') +
          txt('mediaBase', 'R2 媒体域名', '媒体文件直连的公开域名，如 https://media.example.com', cfg, 'url') +
          sel('language', '界面语言', '前台页面的默认语言', cfg, [['zh-CN','中文简体'],['en','English'],['ja','日本語']]) +
          `<div class="config-field"><label class="config-label"><span>${t('config.adminLang')}</span><small>${t('config.adminLangHint')}</small></label><select id="admin-lang-select" onchange="setLang(this.value)"><option value="zh-CN" ${(localStorage.getItem('mosaic_admin_lang')||'zh-CN')==='zh-CN'?'selected':''}>中文简体</option><option value="en" ${localStorage.getItem('mosaic_admin_lang')==='en'?'selected':''}>English</option></select></div>` +
          txt('dateFormat', '日期格式', '如 YYYY-MM-DD', cfg)
        )}
        ${sec('<i class="ri-user-line"></i> 作者信息',
          txt('author.name', '作者名', '显示在文章署名和 RSS 中', cfg) +
          txt('author.email', '邮箱', 'RSS feed 用到，可不填', cfg, 'email')
        )}
        ${sec('<i class="ri-palette-line"></i> 主题与布局',
          sel('theme', '主题配色', '前台颜色模式', cfg, [['auto','自动（跟随系统）'],['light','浅色'],['dark','深色']]) +
          num('pageSize', '每页文章数', '首页和列表页每页显示多少篇', cfg) +
          num('gallerySingleThreshold', '画廊阈值', '少于这个数量的图片用单列大图展示', cfg) +
          tog('cardShowTags', '卡片显示标签', '文章卡片上是否显示标签', cfg) +
          tog('cardShowStats', '卡片显示统计', '文章卡片上是否显示浏览/点赞数', cfg) +
          area('footerText', '页脚文字', '留空则不显示页脚', cfg)
        )}
        ${sec('<i class="ri-image-line"></i> 媒体画质',
          `<div class="config-field">
            <label class="config-label"><span>图片压缩质量</span><small>数值越大画质越好，文件越大（1-100）</small></label>
            <div class="config-quality-group">
              <label>480p<input type="number" data-config="imageQuality.480p" value="${cfgGet(cfg,'imageQuality.480p',75)}" min="1" max="100" /></label>
              <label>720p<input type="number" data-config="imageQuality.720p" value="${cfgGet(cfg,'imageQuality.720p',80)}" min="1" max="100" /></label>
              <label>1080p<input type="number" data-config="imageQuality.1080p" value="${cfgGet(cfg,'imageQuality.1080p',85)}" min="1" max="100" /></label>
            </div>
          </div>` +
          `<div class="config-field">
            <label class="config-label"><span>视频压缩参数</span><small>CRF 越小画质越好体积越大，preset 越快压缩速度越快</small></label>
            <div class="config-quality-group">
              <label>CRF<input type="number" data-config="videoQuality.crf" value="${cfgGet(cfg,'videoQuality.crf',23)}" min="0" max="51" style="width:60px" /></label>
              <select data-config="videoQuality.preset" style="width:100px">${['ultrafast','superfast','veryfast','faster','fast','medium','slow'].map(p => `<option value="${p}" ${cfgGet(cfg,'videoQuality.preset','fast')===p?'selected':''}>${p}</option>`).join('')}</select>
            </div>
          </div>`
        )}
        ${sec('<i class="ri-toggle-line"></i> 功能开关',
          tog('enableBusuanzi', '不蒜子统计', '第三方访客计数（中国大陆访问较快）', cfg) +
          tog('enableVideoCompression', '视频压缩', '上传视频时自动转码 HLS', cfg) +
          num('searchMinChars', '搜索最少字数', '输入多少个字后触发搜索', cfg) +
          `<div class="config-field" style="border-bottom:none;padding-top:12px"><label class="config-label"><span style="font-weight:600">组件开关</span><small>控制前台各模块是否加载</small></label></div>` +
          tog('components.gallery.enabled', '图片画廊', '点击图片放大查看', cfg) +
          tog('components.video.enabled', '视频播放器', '自定义视频播放控件', cfg) +
          tog('components.comments.enabled', '评论系统', 'Giscus 评论区', cfg) +
          tog('components.search.enabled', '搜索功能', '全站文章搜索', cfg) +
          tog('components.likes.enabled', '点赞按钮', '文章点赞互动', cfg) +
          tog('components.stats.enabled', '停留统计', '记录阅读时长', cfg)
        )}
        ${sec('<i class="ri-chat-3-line"></i> Giscus 评论',
          `<p style="font-size:12px;color:var(--color-text-tertiary);margin:0 0 12px">在 <a href="https://giscus.app" target="_blank" style="color:var(--color-accent)">giscus.app</a> 配置后获取以下参数</p>` +
          txt('giscus.repo', 'GitHub 仓库', '如 username/repo', cfg) +
          txt('giscus.repoId', 'Repo ID', '安装 Giscus 后获得', cfg) +
          txt('giscus.category', '分类名', '存放评论的 Discussion 分类', cfg) +
          txt('giscus.categoryId', 'Category ID', '分类的 ID', cfg)
        )}
        ${sec('<i class="ri-puzzle-line"></i> 生成插件',
          tog('plugins.compress-images.enabled', '图片压缩', '构建时自动压缩图片为 WebP', cfg) +
          tog('plugins.compress-videos.enabled', '视频压缩', '构建时自动转码视频为 HLS', cfg) +
          tog('plugins.generate-feed.enabled', 'RSS 订阅', '生成 RSS/Atom feed', cfg) +
          tog('plugins.generate-sitemap.enabled', '网站地图', '生成 sitemap.xml 给搜索引擎', cfg)
        )}
      </div>
    `,
  };
};

pages.config.skeleton = () => `
  <div class="page-header"><div class="skeleton skeleton-line" style="width:140px;height:28px"></div></div>
  <div class="config-grid">
    ${[1,2,3,4,5,6,7].map(() => `<div class="config-section skeleton-card"><div class="skeleton skeleton-line w40" style="height:18px;margin-bottom:12px"></div>${[1,2,3,4].map(() => `<div style="display:flex;gap:12px;padding:8px 0;align-items:center"><div class="skeleton skeleton-line" style="flex:1"></div><div class="skeleton skeleton-line" style="width:160px"></div></div>`).join('')}</div>`).join('')}
  </div>
`;

pages.taxonomy = async (signal) => {
  let tax = { categories: [], tags: [] };
  try { tax = await taxonomy.get(); } catch {}
  if (signal.aborted) return '';
  return `
    <h1>Categories & Tags</h1>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
      <div>
        <h2>Categories</h2>
        ${renderCatTree(tax.categories, '') || '<p style="color:var(--color-text-tertiary)">None</p>'}
      </div>
      <div>
        <h2>Tags</h2>
        ${tax.tags.map(t => `
          <div style="padding:8px 0;border-bottom:1px solid var(--color-border-light);display:flex;justify-content:space-between;align-items:center">
            <span>#${escHtml(t.name)} <small style="color:var(--color-text-tertiary)">(${t.count})</small></span>
            <button class="btn-sm" onclick="doRenameTag('${escHtml(t.name)}')"><i class="ri-edit-line"></i></button>
          </div>`).join('') || '<p style="color:var(--color-text-tertiary)">None</p>'}
      </div>
    </div>
  `;
};

function renderCatTree(cats, prefix, depth=0) {
  if (!cats || !cats.length) return '';
  return cats.map(c => {
    const fullName = prefix ? `${prefix}/${c.name}` : c.name;
    const hasChildren = c.children && c.children.length > 0;
    return `
      <div style="border-bottom:1px solid var(--color-border-light)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;padding-left:${depth*20}px">
          <span>
            ${hasChildren ? `<i class="ri-arrow-down-s-line cat-toggle" data-cat="${escHtml(fullName)}" onclick="toggleCatChildren(this)" style="cursor:pointer;margin-right:4px;font-size:14px"></i>` : '<span style="display:inline-block;width:18px"></span>'}
            ${escHtml(c.name)}
            <small style="color:var(--color-text-tertiary)">(${c.count})</small>
          </span>
          <button class="btn-sm" onclick="doRenameCategory('${escHtml(fullName)}')"><i class="ri-edit-line"></i></button>
        </div>
        ${hasChildren ? `<div class="cat-children" data-cat="${escHtml(fullName)}">${renderCatTree(c.children, fullName, depth+1)}</div>` : ''}
      </div>`;
  }).join('');
}

window.toggleCatChildren = function(icon) {
  const catName = icon.dataset.cat;
  const children = document.querySelector(`.cat-children[data-cat="${CSS.escape(catName)}"]`);
  if (children) {
    children.style.display = children.style.display === 'none' ? '' : 'none';
    icon.classList.toggle('ri-arrow-down-s-line');
    icon.classList.toggle('ri-arrow-right-s-line');
  }
};

pages.trash = async (signal) => {
  let items = [];
  try { items = await trash.list(); } catch {}
  if (signal.aborted) return '';
  return `
    <div class="page-header"><h1>Trash</h1></div>
    ${items.length ? items.map(t => `
      <div style="padding:8px;border-bottom:1px solid var(--color-border-light);display:flex;justify-content:space-between;align-items:center">
        <span>${escHtml(t.title || t.dir || '')}</span>
        <div>
          <button class="btn-sm" onclick="doRestoreTrash('${escHtml(t.dir)}')"><i class="ri-arrow-go-back-line"></i> Restore</button>
          <button class="btn-sm" style="color:#e74c3c" onclick="doPermanentDelete('${escHtml(t.dir)}')"><i class="ri-delete-bin-line"></i></button>
        </div>
      </div>`).join('') : '<p style="color:var(--color-text-tertiary)">Trash is empty</p>'}
  `;
};

pages.deploy = () => `
  <h1>Deploy</h1>
  <p style="color:var(--color-text-secondary);margin-bottom:16px">Build & deploy are now unified. Use the <a href="#build" style="color:var(--color-accent)">Build page</a> to trigger deployment.</p>
  <button class="btn-primary" onclick="location.hash='build'"><i class="ri-tools-line"></i> Go to Build</button>
`;

pages.cleanup = async () => {
  const API = window.__API_BASE__ || '/api';
  const hp = { 'Authorization': 'Bearer ' + (localStorage.getItem('mosaic_token')||'') };
  try {
    const data = await fetch(API + '/cleanup', { headers: hp }).then(r => r.json());
    const orphans = data.orphans || [];
    const total = (data.totalSize / 1048576).toFixed(1);
    return `
      <div class="page-header"><h1>${t('cleanup.title')}</h1></div>

      <!-- Orphan section -->
      <div class="dash-chart-card" style="margin-bottom:14px">
        <h3><i class="ri-delete-bin-line"></i> ${t('cleanup.orphan')}</h3>
        <p style="font-size:13px;color:var(--color-text-secondary);margin-bottom:12px">${t('cleanup.orphanDesc')}</p>
        <div class="dash-cards" style="grid-template-columns:1fr 1fr;margin-bottom:12px">
          <div class="dash-big-card"><span class="dash-big-num">${data.totalOrphans||0}</span><span class="dash-big-label">${t('cleanup.orphanFiles')}</span></div>
          <div class="dash-big-card"><span class="dash-big-num">${total} MB</span><span class="dash-big-label">${t('cleanup.wastedSpace')}</span></div>
        </div>
        ${orphans.length ? `
          <div style="margin-bottom:8px">
            <button class="btn-primary" id="btn-cleanup" onclick="doCleanup()" style="padding:10px 24px;font-size:14px"><i class="ri-delete-bin-line"></i> ${t('cleanup.deleteOrphans')}</button>
            <span style="margin-left:12px;font-size:13px;color:var(--color-text-tertiary)">${orphans.length} files</span>
          </div>
          ${orphans.slice(0, 20).map(o => `<div style="display:flex;align-items:center;gap:10px;padding:4px 0;font-size:12px"><span style="font-family:var(--font-mono)">${escHtml(o.key)}</span><span style="color:var(--color-text-tertiary);margin-left:auto">${(o.size/1024).toFixed(1)}KB</span></div>`).join('')}
          ${orphans.length > 20 ? `<p style="color:var(--color-text-tertiary);font-size:12px">...and ${orphans.length - 20} more</p>` : ''}
        ` : `<p style="color:var(--color-text-tertiary);padding:12px 0">${t('cleanup.noOrphans')}</p>`}
      </div>

      <!-- Cache cleanup section -->
      <div class="dash-chart-card" style="margin-bottom:14px">
        <h3><i class="ri-refresh-line"></i> ${t('cleanup.cacheCleanup')}</h3>
        <p style="font-size:13px;color:var(--color-text-secondary);margin-bottom:12px">${t('cleanup.cacheDesc')}</p>
        <button class="btn-primary" id="btn-clear-cache" onclick="doClearCache()" style="padding:10px 24px;font-size:14px;background:#e74c3c"><i class="ri-delete-bin-line"></i> ${t('cleanup.clearCache')}</button>
      </div>

      <div id="cleanup-progress" style="display:none;margin-top:12px"></div>
    `;
  } catch (e) { return `<h1>Cleanup</h1><p class="error">${escHtml(e.message)}</p>`; }
};
pages.cleanup.skeleton = () => `
  <div class="page-header"><div class="skeleton skeleton-line" style="width:100px;height:28px"></div></div>
  <div class="skeleton-card"><div class="skeleton skeleton-line w40" style="height:18px;margin-bottom:8px"></div><div class="skeleton skeleton-line" style="margin-bottom:12px"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px"><div class="skeleton skeleton-box"></div><div class="skeleton skeleton-box"></div></div></div>
  <div class="skeleton-card" style="margin-top:14px"><div class="skeleton skeleton-line w40" style="height:18px;margin-bottom:8px"></div><div class="skeleton skeleton-line" style="margin-bottom:12px"></div></div>
`;

window.doCleanup = async () => {
  modalConfirm(t('common.deleteOrphan'), '', async () => {
    const API = window.__API_BASE__ || '/api';
    const hp = { 'Authorization': 'Bearer ' + (localStorage.getItem('mosaic_token')||'') };
    const progress = document.getElementById('cleanup-progress');
    const btn = document.getElementById('btn-cleanup');
    if (btn) btn.style.display = 'none';
    if (progress) {
      progress.style.display = 'block';
      progress.innerHTML = '<div class="progress-bar" style="height:6px;background:var(--color-border-light);border-radius:3px;overflow:hidden"><div class="progress-fill" style="height:100%;width:0%;background:var(--color-accent);border-radius:3px;transition:width 0.3s"></div></div><p style="font-size:13px;color:var(--color-text-secondary);margin-top:8px">Deleting orphan files...</p>';
    }
    // Fake progress: 0→95% fast, then crawl
    const fill = progress?.querySelector('.progress-fill');
    let pct = 0;
    const tick = () => { pct += Math.random() * 25 + 5; if (pct > 95) pct = 95; if (fill) fill.style.width = pct + '%'; if (pct < 95) setTimeout(tick, 200 + Math.random() * 300); };
    tick();
    try {
      const result = await fetch(API + '/cleanup', { method: 'DELETE', headers: hp }).then(r => r.json());
      if (fill) fill.style.width = '100%';
      if (result.error) { if (progress) progress.innerHTML = '<p style="color:var(--color-danger);font-size:13px">' + result.error + '</p>'; return; }
      toast(t('common.deleted', { count: result.deleted, size: result.freedMB + ' MB' }), 'success');
      setTimeout(() => location.hash = 'cleanup', 500);
    } catch (e) {
      if (progress) progress.innerHTML = '<p style="color:var(--color-danger);font-size:13px">' + e.message + '</p>';
    }
  });
};

window.doClearCache = async () => {
  modalConfirm(t('common.deleteCache'), '', async () => {
    const API = window.__API_BASE__ || '/api';
    const hp = { 'Authorization': 'Bearer ' + (localStorage.getItem('mosaic_token')||'') };
    const progress = document.getElementById('cleanup-progress');
    const btn = document.getElementById('btn-clear-cache');
    if (btn) btn.style.display = 'none';
    if (progress) {
      progress.style.display = 'block';
      progress.innerHTML = '<div class="progress-bar" style="height:6px;background:var(--color-border-light);border-radius:3px;overflow:hidden"><div class="progress-fill" style="height:100%;width:0%;background:#e74c3c;border-radius:3px;transition:width 0.3s"></div></div><p style="font-size:13px;color:var(--color-text-secondary);margin-top:8px">Deleting processed cache...</p>';
    }
    const fill = progress?.querySelector('.progress-fill');
    let pct = 0;
    const tick = () => { pct += Math.random() * 25 + 5; if (pct > 95) pct = 95; if (fill) fill.style.width = pct + '%'; if (pct < 95) setTimeout(tick, 200 + Math.random() * 300); };
    tick();
    try {
      const result = await fetch(API + '/processed-cache', { method: 'DELETE', headers: hp }).then(r => r.json());
      if (fill) fill.style.width = '100%';
      if (result.error) { if (progress) progress.innerHTML = '<p style="color:var(--color-danger);font-size:13px">' + result.error + '</p>'; return; }
      toast(t('common.deleted', { count: result.deleted, size: result.freedMB + ' MB' }), 'success');
      setTimeout(() => location.hash = 'cleanup', 500);
    } catch (e) {
      if (progress) progress.innerHTML = '<p style="color:var(--color-danger);font-size:13px">' + e.message + '</p>';
    }
  });
};

function modalConfirm(title, msg, onOk) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box">
    <div style="text-align:center;margin-bottom:12px"><i class="ri-error-warning-line" style="font-size:40px;color:#e74c3c"></i></div>
    <h3 style="text-align:center;margin-bottom:8px">${title}</h3>
    <p style="text-align:center;font-size:13px;color:var(--color-text-secondary);margin-bottom:20px">${msg}</p>
    <div style="display:flex;gap:10px;justify-content:center">
      <button class="btn-secondary" id="modal-cancel" style="min-width:100px">${t('common.cancel')}</button>
      <button class="btn-primary" id="modal-ok" style="min-width:100px;background:#e74c3c">${t('common.deleteAll')}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#modal-ok').onclick = () => { overlay.remove(); onOk(); };
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
}

// ── Helpers ─────────────────────────────────
function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Config helpers ──────────────────────────
function cfgGet(obj, path, def = '') {
  return path.split('.').reduce((o, k) => (o || {})[k], obj) ?? def;
}
function sec(title, body) {
  return `<div class="config-section"><h3 class="config-section-title">${title}</h3><div class="config-fields">${body}</div></div>`;
}
function txt(key, label, hint, cfg, type = 'text') {
  return `<div class="config-field"><label class="config-label"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label><input type="${type}" data-config="${key}" value="${escHtml(String(cfgGet(cfg, key)))}" /></div>`;
}
function area(key, label, hint, cfg) {
  return `<div class="config-field"><label class="config-label"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label><textarea data-config="${key}" rows="2">${escHtml(String(cfgGet(cfg, key)))}</textarea></div>`;
}
function num(key, label, hint, cfg) {
  return `<div class="config-field"><label class="config-label"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label><input type="number" data-config="${key}" data-type="number" value="${cfgGet(cfg, key, 0)}" /></div>`;
}
function sel(key, label, hint, cfg, options) {
  const val = cfgGet(cfg, key);
  return `<div class="config-field"><label class="config-label"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label><select data-config="${key}">${options.map(o => `<option value="${o[0]}" ${val === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div>`;
}
function tog(key, label, hint, cfg) {
  const val = cfgGet(cfg, key, false);
  return `<div class="config-field"><label class="config-label"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</label><label class="toggle-switch"><input type="checkbox" data-config="${key}" data-type="bool" ${val ? 'checked' : ''} /><span class="toggle-slider"></span></label></div>`;
}

// ── Existing media display ─────────────────
async function loadExistingMedia(slug) {
  const el = document.getElementById('existing-media');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--color-text-tertiary);font-size:13px">Loading media...</p>';
  try {
    const data = await mediaApi.list(slug);
    let html = '<h3 style="margin-bottom:8px">Existing Media</h3>';
    if (data.photos?.length) {
      html += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">' +
        data.photos.map(f => `
          <div style="position:relative;border:1px solid var(--color-border-light);border-radius:6px;overflow:hidden;background:var(--color-surface)">
            <img src="${escHtml(f.url || '')}" alt="${escHtml(f.name)}" style="width:200px;height:200px;object-fit:cover;display:block" onerror="this.outerHTML=''" />
            <div style="padding:2px 6px;font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
            <button onclick="doDeleteMedia('${escHtml(slug)}','${escHtml(f.name)}','photos')" style="width:100%;border:none;background:var(--color-surface);color:#e74c3c;font-size:11px;cursor:pointer;padding:2px;border-top:1px solid var(--color-border-light)">Delete</button>
          </div>`).join('') +
        '</div>';
    }
    if (data.videos?.length) {
      html += '<div style="margin-bottom:12px">' +
        data.videos.map(f => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border:1px solid var(--color-border-light);border-radius:4px;margin-bottom:4px;font-size:13px;background:var(--color-surface)">
            <span><i class="ri-video-line" style="margin-right:4px;color:var(--color-accent)"></i>${escHtml(f.name)}</span>
            <button onclick="doDeleteMedia('${escHtml(slug)}','${escHtml(f.name)}','videos')" class="btn-sm" style="color:#e74c3c">Delete</button>
          </div>`).join('') +
        '</div>';
    }
    if (!data.photos?.length && !data.videos?.length) {
      html += '<p style="color:var(--color-text-tertiary)">No media uploaded yet. Use the upload zone above.</p>';
    }
    el.innerHTML = html;
  } catch {
    el.innerHTML = '<p style="color:var(--color-text-tertiary)">Could not load media</p>';
  }
}

// ── Upload flow ────────────────────────────
function getCurrentSlug() {
  return state.params.slug || document.getElementById('fm-slug')?.value || '';
}

async function handleUploadFiles(files) {
  const slug = getCurrentSlug();
  if (!slug) { alert('Please save the post first (fill in the slug field)'); return; }

  const progressEl = document.getElementById('upload-progress');
  if (!progressEl) return;
  progressEl.innerHTML = '';

  const token = getToken();
  let done = 0;
  const total = files.length;

  for (const file of files) {
    const itemEl = document.createElement('div');
    itemEl.className = 'upload-item';
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const icon = ['jpg','jpeg','png','webp','gif','svg'].includes(ext) ? 'ri-image-line' :
                 ['mp4','mov','mkv','webm'].includes(ext) ? 'ri-video-line' :
                 ['mp3','flac','wav','ogg'].includes(ext) ? 'ri-music-line' : 'ri-file-line';
    const sizeStr = file.size > 1024*1024 ? (file.size/1024/1024).toFixed(1)+'MB' : (file.size/1024).toFixed(0)+'KB';
    itemEl.innerHTML = `<div class="upload-item-icon"><i class="${icon}"></i></div>
      <div class="upload-item-info">
        <div class="upload-item-name">${escHtml(file.name)}</div>
        <div class="upload-item-meta"><span>${sizeStr}</span></div>
        <div class="upload-item-bar"><div class="upload-item-fill" style="width:0%"></div></div>
      </div>
      <div class="upload-item-status">0%</div>`;
    progressEl.appendChild(itemEl);

    try {
      const url = upload.directUrl(slug, file.name);
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const fillEl = itemEl.querySelector('.upload-item-fill');
        const statusEl = itemEl.querySelector('.upload-item-status');
        const metaEl = itemEl.querySelector('.upload-item-meta');
        xhr.upload.addEventListener('progress', e => {
          if (e.lengthComputable) {
            const pct = Math.round(e.loaded / e.total * 100);
            if (fillEl) fillEl.style.width = pct + '%';
            if (statusEl) statusEl.textContent = pct + '%';
            if (metaEl && pct >= 100) metaEl.innerHTML = '<span>Processing on server...</span>';
          }
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error('HTTP ' + xhr.status));
        });
        xhr.addEventListener('error', () => reject(new Error('Network error')));
        xhr.timeout = 300000; // 5 min timeout for large files
        xhr.upload.onprogress = xhr.upload.onprogress;
        xhr.open('POST', url);
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.send(file);
      });
      done++;
      itemEl.classList.add('upload-done');
      itemEl.querySelector('.upload-item-status').innerHTML = '<i class="ri-check-line" style="color:#2ecc71"></i>';
      itemEl.querySelector('.upload-item-meta').innerHTML = '<span style="color:#2ecc71">' + t('editor.done') + '</span>';
    } catch (err) {
      itemEl.classList.add('upload-error');
      itemEl.querySelector('.upload-item-status').innerHTML = '<i class="ri-close-line" style="color:#e74c3c"></i>';
      itemEl.querySelector('.upload-item-meta').innerHTML = '<span style="color:#e74c3c">' + escHtml(err.message) + '</span>';
    }
  }

  if (done > 0) {
    checkDirty();
    loadExistingMedia(slug);
  }
}

function setupUploadZone() {
  const main = document.getElementById('main-content');
  if (!main) return;

  main.addEventListener('click', e => {
    const zone = e.target.closest('.upload-zone');
    if (!zone) return;
    zone.querySelector('input[type="file"]')?.click();
  });

  main.addEventListener('change', e => {
    if (!e.target.closest('#editor-media-input')) return;
    if (e.target.files?.length) handleUploadFiles([...e.target.files]);
    e.target.value = '';
  });

  main.addEventListener('dragover', e => {
    if (e.target.closest('.upload-zone')) { e.preventDefault(); e.stopPropagation(); }
  });

  main.addEventListener('drop', e => {
    const zone = e.target.closest('.upload-zone');
    if (!zone) return;
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer?.files?.length) handleUploadFiles([...e.dataTransfer.files]);
  });
}

// ── Global actions ─────────────────────────
window.doSavePost = async () => {
  let slug = document.getElementById('fm-slug').value;
  if (!slug) {
    const now = new Date();
    slug = now.getFullYear() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0') + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0') + String(now.getSeconds()).padStart(2,'0');
    // Check collision with existing posts
    const existingSlugs = (state.posts || []).map(p => p.slug);
    if (existingSlugs.includes(slug)) { let n=1; while (existingSlugs.includes(slug+'-'+n)) n++; slug += '-'+n; }
    document.getElementById('fm-slug').value = slug;
  }
  const frontMatter = {
    title: document.getElementById('fm-title').value,
    date: document.getElementById('fm-date').value,
    category: document.getElementById('fm-category').value,
    tags: document.getElementById('fm-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    description: document.getElementById('fm-desc').value,
    layout: document.getElementById('fm-layout').value,
    cover: document.getElementById('fm-cover').value,
    views: parseInt(document.getElementById('fm-views')?.value) || 0,
    likes: parseInt(document.getElementById('fm-likes')?.value) || 0,
  };
  const body = document.getElementById('fm-body').value;

  try {
    if (state.params.slug) {
      await postsApi.update(state.params.slug, { frontMatter, body });
    } else {
      await postsApi.create({ slug, frontMatter, body });
    }
    checkDirty();
    location.hash = 'posts';
  } catch (err) { toast(t('editor.saveFailed') + ': ' + err.message, 'error'); }
};

window.doDeletePost = async (slug) => {
  modalConfirm(t('common.deletePost', { slug: slug }), '', async () => {
    try { await postsApi.delete(slug); checkDirty(); location.reload(); }
    catch (err) { toast(t('common.delete') + ': ' + err.message, 'error'); }
  });
};

window.doDeleteMedia = async (slug, file, type) => {
  modalConfirm('Delete ' + file + '?', 'This file will be permanently deleted from R2.', async () => {
    try { await mediaApi.delete(slug, file, type); location.reload(); }
    catch (err) { toast('Delete failed: ' + err.message, 'error'); }
  });
};

window.doTriggerBuild = async () => {
  const btn = document.querySelector('#build .btn-primary, .page-header .btn-primary');
  const origHTML = btn?.innerHTML || '';
  if (btn) btn.innerHTML = '<span class="btn-spinner"></span> ' + t('common.loading');

  try {
    const result = await build.trigger();
    hideDirtyBanner();
    const msg = `Build triggered via ${result.method || 'push'}!`;
    if (result.wfError) toast('Fallback used: ' + result.wfError, 'info', 6000);
    toast(msg, 'success', 5000);
    if (location.hash !== '#build') location.hash = 'build';
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('already in progress') || msg.includes('BUILD_RUNNING')) {
      toast(t('build.alreadyRunning'), 'info', 5000);
      if (location.hash !== '#build') location.hash = 'build';
    } else {
      toast(t('build.triggerFailed') + ': ' + msg, 'error', 8000);
    }
  } finally {
    if (btn) btn.innerHTML = origHTML;
  }
};

window.uploadFavicon = async function(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 102400) { toast(t('config.saveFailed') + ': 文件不能超过 100KB', 'error'); return; }
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!['svg','png','ico'].includes(ext)) { toast(t('config.saveFailed') + ': 仅支持 SVG/PNG/ICO', 'error'); return; }
  const token = getToken();
  const API = window.__API_BASE__ || '/api';
  try {
    const resp = await fetch(`${API}/upload/direct/site-data/favicon.${ext}`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': file.type || 'image/svg+xml' },
      body: file,
    });
    if (!resp.ok) throw new Error('Upload failed');
    const mediaBase = state.mediaBase || window.__MEDIA_BASE__ || '';
    const url = mediaBase ? `${mediaBase}/originals/site-data/others/favicon.${ext}` : `/api/media/file/site-data/favicon.${ext}`;
    document.getElementById('favicon-preview').src = url;
    document.getElementById('favicon-value').value = url;
    toast('图标上传成功', 'success');
  } catch (e) { toast('上传失败: ' + e.message, 'error'); }
};

window.doSaveConfig = async () => {
  const data = {};
  document.querySelectorAll('[data-config]').forEach(el => {
    const keys = el.dataset.config.split('.');
    const type = el.dataset.type || (el.type === 'number' ? 'number' : 'text');
    let val;
    if (type === 'bool') val = el.checked;
    else if (type === 'number') val = parseInt(el.value) || 0;
    else val = el.value;
    let obj = data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {};
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = val;
  });
  try {
    await config.update(data);
    checkDirty();
    toast(t('config.saved'), 'success');
  } catch (err) { toast(t('config.saveFailed') + ': ' + err.message, 'error'); }
};

window.doRenameCategory = async (oldName) => {
  const newName = prompt('Rename category "' + oldName + '" to:', oldName);
  if (!newName || newName === oldName) return;
  try { await taxonomy.renameCategory(oldName, newName); toast(t('common.renamed', { old: oldName, new: newName }), 'success'); setTimeout(() => location.reload(), 500); }
  catch (err) { toast(t('common.renameFailed') + ': ' + err.message, 'error'); }
};

window.doRenameTag = async (oldName) => {
  const newName = prompt('Rename tag "' + oldName + '" to:', oldName);
  if (!newName || newName === oldName) return;
  try { await taxonomy.renameTag(oldName, newName); toast(t('common.renamed', { old: oldName, new: newName }), 'success'); setTimeout(() => location.reload(), 500); }
  catch (err) { toast(t('common.renameFailed') + ': ' + err.message, 'error'); }
};

window.doRestoreTrash = async (dir) => {
  try { await trash.restore(dir); location.reload(); }
  catch (err) { alert('Restore failed: ' + err.message); }
};

window.doPermanentDelete = async (dir) => {
  modalConfirm('Permanently delete "' + dir + '"?', 'This cannot be undone.', async () => {
    try { await trash.permanentDelete(dir); location.reload(); }
    catch (err) { toast('Delete failed: ' + err.message, 'error'); }
  });
};

window.switchPostsView = (view, silent) => {
  const tableEl = document.getElementById('posts-table-view');
  const cardsEl = document.getElementById('posts-cards-view');
  if (tableEl) tableEl.style.display = view === 'cards' ? 'none' : '';
  if (cardsEl) cardsEl.style.display = view === 'cards' ? '' : 'none';
  document.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (!silent) localStorage.setItem('mosaic_posts_view', view);
  // Re-apply current filter
  const searchQ = document.getElementById('post-search')?.value || '';
  const catQ = document.getElementById('post-cat-filter')?.value || '';
  window.filterPosts(searchQ);
  if (catQ) window.filterPostsByCat(catQ);
};

window.filterPosts = (query) => {
  const q = query.toLowerCase();
  document.querySelectorAll('#posts-table tbody tr, .admin-post-card').forEach(el => {
    if (!q) { el.style.display = ''; return; }
    el.style.display = (el.dataset.search || '').toLowerCase().includes(q) ? '' : 'none';
  });
};

window.filterPostsByCat = (cat) => {
  document.querySelectorAll('#posts-table tbody tr, .admin-post-card').forEach(el => {
    if (!cat) { el.style.display = ''; return; }
    el.style.display = (el.dataset.cat || '') === cat ? '' : 'none';
  });
};

// ── Init ───────────────────────────────────
async function init() {
  const loadingEl = document.getElementById('loading-screen');
  const hideLoading = () => { if (loadingEl) loadingEl.style.display = 'none'; };

  // Apply i18n to static HTML
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });

  // Safety: hide loading after 5s no matter what
  setTimeout(hideLoading, 5000);

  const token = getToken();
  if (token) {
    try {
      await auth.refresh();
      state.authStatus = 'ok';
    } catch {
      hideLoading();
      showLogin();
      return;
    }
    hideLoading();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    setupUploadZone();
    checkDirty();
    onHashChange();
  } else {
    hideLoading();
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Spin animation
const styleEl = document.createElement('style');
styleEl.textContent = '@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}';
document.head.appendChild(styleEl);
