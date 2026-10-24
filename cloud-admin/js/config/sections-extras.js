/**
 * Config sections for build/deployment tuning, feature toggles, Giscus and
 * generation plugins. Behaviour is unchanged from the original config page.
 */
import { t } from '../i18n.js?v=1';
import { cfgGet, textField, numberField, toggleField } from './fields.js?v=1';

function buildSection(cfg) {
  return `
    ${numberField({ key: 'media.timeoutMinutes', label: t('config.mediaTimeout'), hint: t('config.mediaTimeoutHint'), value: cfgGet(cfg, 'media.timeoutMinutes', 90), min: 10, max: 600 })}
    ${numberField({ key: 'media.maxRetries', label: t('config.mediaRetries'), value: cfgGet(cfg, 'media.maxRetries', 3), min: 0, max: 10 })}
    ${numberField({ key: 'media.debounceMs', label: t('config.mediaDebounce'), value: cfgGet(cfg, 'media.debounceMs', 3000), min: 0, max: 600000 })}
    ${numberField({ key: 'media.retentionDays', label: t('config.mediaRetention'), value: cfgGet(cfg, 'media.retentionDays', 7), min: 0, max: 365 })}
    ${numberField({ key: 'upload.concurrency', label: t('config.uploadConcurrency'), value: cfgGet(cfg, 'upload.concurrency', 3), min: 1, max: 6 })}
    ${textField({ key: 'deployment.branch', label: t('config.deployBranch'), value: cfgGet(cfg, 'deployment.branch') })}
    ${textField({ key: 'deployment.siteProject', label: t('config.siteProject'), value: cfgGet(cfg, 'deployment.siteProject') })}
    ${textField({ key: 'deployment.adminProject', label: t('config.adminProject'), value: cfgGet(cfg, 'deployment.adminProject') })}
    ${numberField({ key: 'build.timeoutMinutes', label: t('config.buildTimeout'), hint: t('config.buildTimeoutHint'), value: cfgGet(cfg, 'build.timeoutMinutes', 90), min: 10, max: 360, step: 5, width: '120px' })}
    ${numberField({ key: 'videoQuality.uploadAfterTiers', label: t('config.uploadAfterTiers'), hint: t('config.uploadAfterTiersHint'), value: cfgGet(cfg, 'videoQuality.uploadAfterTiers', 1), min: 1, max: 5, width: '120px' })}
  `;
}

function featuresSection(cfg) {
  return `
    ${toggleField({ key: 'enableBusuanzi', label: t('config.busuanzi'), hint: t('config.busuanziHint'), checked: cfgGet(cfg, 'enableBusuanzi', false) })}
    ${numberField({ key: 'searchMinChars', label: t('config.searchMin'), hint: t('config.searchMinHint'), value: cfgGet(cfg, 'searchMinChars', 1), min: 1, max: 10 })}
    <div class="config-group-heading" role="heading" aria-level="3"><span>${t('config.compSwitch')}</span><small>${t('config.compSwitchHint')}</small></div>
    ${toggleField({ key: 'components.gallery.enabled', label: t('config.gallery'), hint: t('config.galleryHint'), checked: cfgGet(cfg, 'components.gallery.enabled', true) })}
    ${toggleField({ key: 'components.video.enabled', label: t('config.video'), hint: t('config.videoHint'), checked: cfgGet(cfg, 'components.video.enabled', true) })}
    ${toggleField({ key: 'components.comments.enabled', label: t('config.comments'), hint: t('config.commentsHint'), checked: cfgGet(cfg, 'components.comments.enabled', false) })}
    ${toggleField({ key: 'components.search.enabled', label: t('config.searchToggle'), hint: t('config.searchToggleHint'), checked: cfgGet(cfg, 'components.search.enabled', true) })}
    ${toggleField({ key: 'components.likes.enabled', label: t('config.likes'), hint: t('config.likesHint'), checked: cfgGet(cfg, 'components.likes.enabled', true) })}
    ${toggleField({ key: 'components.stats.enabled', label: t('config.stats'), hint: t('config.statsHint'), checked: cfgGet(cfg, 'components.stats.enabled', true) })}
  `;
}

function giscusSection(cfg) {
  return `
    <p class="config-inline-hint">${t('config.giscusHint')} <a href="https://giscus.app" target="_blank" rel="noopener">giscus.app</a></p>
    ${textField({ key: 'giscus.repo', label: t('config.giscusRepo'), hint: t('config.giscusRepoHint'), value: cfgGet(cfg, 'giscus.repo') })}
    ${textField({ key: 'giscus.repoId', label: t('config.giscusRepoId'), hint: t('config.giscusRepoIdHint'), value: cfgGet(cfg, 'giscus.repoId') })}
    ${textField({ key: 'giscus.category', label: t('config.giscusCat'), hint: t('config.giscusCatHint'), value: cfgGet(cfg, 'giscus.category') })}
    ${textField({ key: 'giscus.categoryId', label: t('config.giscusCatId'), hint: t('config.giscusCatIdHint'), value: cfgGet(cfg, 'giscus.categoryId') })}
  `;
}

function pluginsSection(cfg) {
  return `
    ${toggleField({ key: 'plugins.compress-images.enabled', label: t('config.imgCompress'), hint: t('config.imgCompressHint'), checked: cfgGet(cfg, 'plugins.compress-images.enabled', true) })}
    ${toggleField({ key: 'plugins.compress-videos.enabled', label: t('config.videoCompressPlugin'), hint: t('config.videoCompressPluginHint'), checked: cfgGet(cfg, 'plugins.compress-videos.enabled', true) })}
    ${toggleField({ key: 'plugins.generate-feed.enabled', label: t('config.rss'), hint: t('config.rssHint'), checked: cfgGet(cfg, 'plugins.generate-feed.enabled', true) })}
    ${toggleField({ key: 'plugins.generate-sitemap.enabled', label: t('config.sitemap'), hint: t('config.sitemapHint'), checked: cfgGet(cfg, 'plugins.generate-sitemap.enabled', true) })}
  `;
}

/** Section descriptors consumed by the config page shell. */
export const extraSections = [
  { id: 'build', icon: 'ri-rocket-line', label: () => t('config.build'), body: buildSection },
  { id: 'features', icon: 'ri-toggle-line', label: () => t('config.features'), body: featuresSection },
  { id: 'giscus', icon: 'ri-chat-3-line', label: () => t('config.giscus'), body: giscusSection },
  { id: 'plugins', icon: 'ri-puzzle-line', label: () => t('config.plugins'), body: pluginsSection },
];
