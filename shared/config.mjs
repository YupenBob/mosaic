/** Runtime-neutral configuration shared by the generator and Worker. */
export const THEME_MODES = ['auto', 'light', 'dark'];
export const THEME_ACCENTS = ['blue', 'violet', 'emerald', 'rose', 'amber', 'slate'];
export const CARD_SIZES = ['large', 'compact'];
export const CARD_IMAGES = ['full', 'cover'];
export const CARD_LAYOUTS = ['masonry', 'grid'];
export const MOTION_SPRINGS = ['none', 'snappy', 'smooth', 'bouncy'];
/** ffmpeg `minterpolate` mi_mode enum. */
export const INTERPOLATION_MODES = ['mci', 'blend', 'dup'];
/** ffmpeg `minterpolate` mc_mode enum. */
export const INTERPOLATION_MC_MODES = ['aobmc', 'vmm', 'obmc'];
/** ffmpeg `minterpolate` me_mode enum. */
export const INTERPOLATION_ME_MODES = ['bidir', 'epzs', 'esa'];
export const DEFAULTS = {
  language: 'zh-CN',
  theme: 'auto',
  themeMode: {
    default: 'auto',
    accent: 'blue',
    allowVisitorToggle: true,
    showMenu: true,
  },
  experience: {
    card: { size: 'large', image: 'full', layout: 'masonry' },
    modal: { enabled: true },
    verticalFeed: { enabled: true },
    motion: { enabled: true, spring: 'snappy' },
    morphIcons: { enabled: true },
  },
  pageSize: 50,
  gallerySingleThreshold: 5,
  apiBase: '/api',
  mediaBase: '',
  coverAspectMin: 0.5625,
  coverAspectMax: 1.5,
  searchMinChars: 2,
  search: { debounceMs: 250, maxResults: 10 },
  imageQuality: { '480p': 75, '720p': 80, '1080p': 85 },
  videoQuality: {
    crf: 23,
    preset: 'veryfast',
    maxHeight: 1080,
    uploadAfterTiers: 1,
    fps: 30,
    audioBitrate: '128k',
    segmentSeconds: 6,
    posterSeconds: 1,
    /**
     * Optical-flow frame interpolation (ffmpeg `minterpolate`). Disabled by
     * default; only an enabled config participates in the processing
     * fingerprint, so enabling it never reschedules assets implicitly.
     */
    interpolation: {
      enabled: false,
      fps: 60,
      mode: 'mci',
      mcMode: 'aobmc',
      meMode: 'bidir',
      vsbmc: true,
    },
  },
  build: { timeoutMinutes: 90 },
  deployment: {
    branch: 'main',
    siteWorkflow: 'pipeline.yml',
    mediaWorkflow: 'media.yml',
    siteProject: 'mosaic',
    adminProject: 'mosaic-admin',
    workerName: 'mosaic-api',
    allowedOrigins: [],
    runner: 'ubuntu-latest',
  },
  mediaSource: { type: 'r2', bucket: 'mosaic-media', endpoint: '' },
  media: {
    timeoutMinutes: 90,
    budgetRatio: 0.85,
    maxRetries: 3,
    debounceMs: 10000,
    retryMs: 30000,
    leaseMs: 120000,
    pollMs: 30000,
    retentionDays: 30,
    deploymentHistory: 20,
    reconcileBatchSize: 25,
    cacheControl: 'public, max-age=86400',
    manifestKey: 'site-data/media-manifest.json',
    /** Keep originals/ after decoding. Never part of the processing fingerprint. */
    keepSourceFiles: true,
    image: { placeholderWidth: 150, placeholderQuality: 30 },
    audio: { bitrates: ['128k', '320k'], waveformBuckets: 400, sampleRate: 8000 },
  },
  upload: {
    concurrency: 3,
    multipartThreshold: 104857600,
    partSize: 104857600,
    partConcurrency: 3,
    partRetries: 3,
    presignSeconds: 3600,
    maxFileBytes: 5368709120,
  },
  cache: { postsMs: 60000, configMs: 120000, diskMs: 300000, usageMaxAgeMs: 86400000 },
  admin: {
    dirtyPollMs: 60000,
    jobPollMs: 5000,
    idlePollMs: 30000,
    hiddenPollMs: 60000,
    requestTimeoutMs: 15000,
    cacheMs: 15000,
    buildCacheMs: 3000,
  },
  player: {
    defaultAspect: 16 / 9,
    requestVersion: 'cors-v1',
    speeds: [0.5, 0.75, 1, 1.25, 1.5, 2],
    qualityOrder: ['4K', '1080p', '720p', '480p', '360p', '240p'],
    hls: {
      startLevel: 0,
      enableWorker: true,
      capLevelToPlayerSize: true,
      abrEwmaDefaultEstimate: 2500000,
      autoStartLoad: false,
      startFragPrefetch: false,
      maxBufferLength: 90,
      maxMaxBufferLength: 300,
      backBufferLength: 30,
      fragLoadingMaxRetry: 6,
      fragLoadingTimeOut: 60000,
      manifestLoadingTimeOut: 10000,
      levelLoadingTimeOut: 60000,
    },
  },
};

export function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base;
  if (!base || typeof base !== 'object' || !patch || typeof patch !== 'object') return patch ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid configuration key');
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

export function normalizeConfig(raw = {}, env = {}) {
  const config = deepMerge(structuredClone(DEFAULTS), raw);
  // Legacy `theme` string maps onto themeMode.default unless the new key says otherwise.
  if (raw.themeMode?.default === undefined && THEME_MODES.includes(raw.theme)) config.themeMode.default = raw.theme;
  // Keep emitting the legacy scalar for older templates/consumers.
  config.theme = config.themeMode.default;
  config.plugins = deepMerge(
    { 'compress-images': { enabled: true }, 'compress-videos': { enabled: raw.enableVideoCompression !== false } },
    raw.plugins || {},
  );
  config.media.timeoutMinutes = raw.media?.timeoutMinutes ?? raw.build?.timeoutMinutes ?? DEFAULTS.media.timeoutMinutes;
  config.mediaSource.bucket = env.R2_BUCKET || config.mediaSource.bucket;
  config.mediaSource.endpoint = env.R2_ENDPOINT || config.mediaSource.endpoint;
  config.mediaBase = env.R2_PUBLIC_URL || config.mediaBase;
  config.deployment.branch = env.SITE_BRANCH || config.deployment.branch;
  config.deployment.siteWorkflow = env.SITE_WORKFLOW || config.deployment.siteWorkflow;
  config.deployment.mediaWorkflow = env.MEDIA_WORKFLOW || config.deployment.mediaWorkflow;
  return config;
}

/**
 * Append an enum validation error when `value` is not one of `allowed`.
 * @param {string[]} errors
 * @param {string} name
 * @param {unknown} value
 * @param {readonly string[]} allowed
 */
function checkEnum(errors, name, value, allowed) {
  if (!allowed.includes(value)) errors.push(`${name} must be one of ${allowed.join(', ')}`);
}

/**
 * Append a boolean validation error when `value` is not a boolean.
 * @param {string[]} errors
 * @param {string} name
 * @param {unknown} value
 */
function checkBoolean(errors, name, value) {
  if (typeof value !== 'boolean') errors.push(`${name} must be a boolean`);
}

/**
 * Validate optical-flow interpolation settings. Shared by full config
 * validation and the Worker's `POST /api/media/interpolate` fps override.
 * @param {unknown} value
 * @param {string} [prefix]
 * @returns {string[]} human-readable errors (empty when valid)
 */
export function validateInterpolation(value, prefix = 'videoQuality.interpolation') {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${prefix} must be an object`];
  checkBoolean(errors, `${prefix}.enabled`, value.enabled);
  if (!Number.isInteger(value.fps) || value.fps < 24 || value.fps > 120)
    errors.push(`${prefix}.fps must be an integer in 24..120`);
  checkEnum(errors, `${prefix}.mode`, value.mode, INTERPOLATION_MODES);
  checkEnum(errors, `${prefix}.mcMode`, value.mcMode, INTERPOLATION_MC_MODES);
  checkEnum(errors, `${prefix}.meMode`, value.meMode, INTERPOLATION_ME_MODES);
  checkBoolean(errors, `${prefix}.vsbmc`, value.vsbmc);
  return errors;
}

/**
 * Merge a partial interpolation override over a base (typically the configured
 * defaults). Unknown keys are ignored; `enabled` defaults to `true` when an
 * override is supplied, because requesting interpolation means enabling it.
 * @param {object} base
 * @param {object} [override]
 * @returns {{enabled:boolean, fps:number, mode:string, mcMode:string, meMode:string, vsbmc:boolean}}
 */
export function mergeInterpolation(base = {}, override) {
  const merged = { ...DEFAULTS.videoQuality.interpolation, ...base };
  if (override && typeof override === 'object')
    for (const key of Object.keys(DEFAULTS.videoQuality.interpolation))
      if (override[key] !== undefined) merged[key] = override[key];
  if (override && merged.enabled !== true && override.enabled === undefined) merged.enabled = true;
  return merged;
}

export function validateConfig(config) {
  const errors = [];
  checkEnum(errors, 'themeMode.default', config.themeMode?.default, THEME_MODES);
  checkEnum(errors, 'themeMode.accent', config.themeMode?.accent, THEME_ACCENTS);
  checkBoolean(errors, 'themeMode.allowVisitorToggle', config.themeMode?.allowVisitorToggle);
  checkBoolean(errors, 'themeMode.showMenu', config.themeMode?.showMenu);
  checkEnum(errors, 'experience.card.size', config.experience?.card?.size, CARD_SIZES);
  checkEnum(errors, 'experience.card.image', config.experience?.card?.image, CARD_IMAGES);
  checkEnum(errors, 'experience.card.layout', config.experience?.card?.layout, CARD_LAYOUTS);
  for (const name of ['modal', 'verticalFeed', 'motion', 'morphIcons'])
    checkBoolean(errors, `experience.${name}.enabled`, config.experience?.[name]?.enabled);
  checkEnum(errors, 'experience.motion.spring', config.experience?.motion?.spring, MOTION_SPRINGS);
  checkBoolean(errors, 'media.keepSourceFiles', config.media?.keepSourceFiles);
  if (config.videoQuality?.interpolation !== undefined)
    errors.push(...validateInterpolation(config.videoQuality.interpolation));
  if (!Number.isFinite(config.player?.defaultAspect) || config.player.defaultAspect <= 0)
    errors.push('player.defaultAspect must be positive');
  for (const [name, value, min, max] of [
    ['pageSize', config.pageSize, 1, 10000],
    ['build.timeoutMinutes', config.build?.timeoutMinutes, 10, 360],
    ['media.timeoutMinutes', config.media?.timeoutMinutes, 10, 360],
    ['media.maxRetries', config.media?.maxRetries, 0, 20],
    ['media.deploymentHistory', config.media?.deploymentHistory, 1, 100],
    ['media.reconcileBatchSize', config.media?.reconcileBatchSize, 1, 100],
    ['videoQuality.crf', config.videoQuality?.crf, 0, 51],
    ['videoQuality.maxHeight', config.videoQuality?.maxHeight, 1, 4320],
    ['videoQuality.uploadAfterTiers', config.videoQuality?.uploadAfterTiers, 1, 6],
    ['upload.concurrency', config.upload?.concurrency, 1, 32],
    ['upload.partConcurrency', config.upload?.partConcurrency, 1, 32],
    ['upload.partSize', config.upload?.partSize, 5242880, 104857600],
    ['upload.partRetries', config.upload?.partRetries, 0, 20],
    ['upload.presignSeconds', config.upload?.presignSeconds, 1, 604800],
    ['upload.maxFileBytes', config.upload?.maxFileBytes, 1, 5368709120],
    ['media.audio.waveformBuckets', config.media?.audio?.waveformBuckets, 1, 10000],
    ['media.audio.sampleRate', config.media?.audio?.sampleRate, 1000, 192000],
    ['media.image.placeholderWidth', config.media?.image?.placeholderWidth, 1, 4096],
    ['media.image.placeholderQuality', config.media?.image?.placeholderQuality, 1, 100],
    ['videoQuality.fps', config.videoQuality?.fps, 1, 120],
    ['videoQuality.segmentSeconds', config.videoQuality?.segmentSeconds, 1, 60],
  ])
    if (!Number.isInteger(value) || value < min || value > max)
      errors.push(`${name} must be an integer in ${min}..${max}`);
  for (const [tier, quality] of Object.entries(config.imageQuality || {})) {
    if (!/^\d+p$/.test(tier) || !Number.isInteger(quality) || quality < 1 || quality > 100)
      errors.push(`Invalid imageQuality.${tier}`);
  }
  if (!(config.media?.budgetRatio > 0 && config.media.budgetRatio < 1))
    errors.push('media.budgetRatio must be between 0 and 1');
  for (const key of ['debounceMs', 'retryMs', 'leaseMs', 'pollMs', 'retentionDays'])
    if (!Number.isFinite(config.media?.[key]) || config.media[key] < 0) errors.push(`Invalid media.${key}`);
  if (
    !['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].includes(
      config.videoQuality?.preset,
    )
  )
    errors.push('Invalid videoQuality.preset');
  if (
    !Array.isArray(config.media?.audio?.bitrates) ||
    !config.media.audio.bitrates.length ||
    config.media.audio.bitrates.some((bitrate) => !/^\d+k$/.test(bitrate))
  )
    errors.push('Invalid media.audio.bitrates');
  if (!/^\d+k$/.test(config.videoQuality?.audioBitrate)) errors.push('Invalid videoQuality.audioBitrate');
  for (const key of ['leaseMs', 'pollMs']) if (!(config.media?.[key] > 0)) errors.push(`media.${key} must be positive`);
  for (const key of ['requestTimeoutMs', 'jobPollMs', 'dirtyPollMs', 'idlePollMs', 'hiddenPollMs'])
    if (!(config.admin?.[key] > 0)) errors.push(`admin.${key} must be positive`);
  for (const key of ['cacheMs', 'buildCacheMs'])
    if (!(config.admin?.[key] >= 0)) errors.push(`admin.${key} must not be negative`);
  if (!Number.isInteger(config.player?.hls?.startLevel) || config.player.hls.startLevel < -1)
    errors.push('player.hls.startLevel must be an integer of -1 or greater');
  if (!config.deployment?.branch || !config.mediaSource?.bucket || !config.media?.manifestKey)
    errors.push('Deployment branch, bucket and manifest key are required');
  return errors;
}

export function processingConfig(config, folder) {
  if (folder === 'videos') {
    const video = { ...config.videoQuality };
    // Fingerprint compatibility: disabled interpolation must not invalidate the
    // fingerprint of every existing asset (which would retranscode the library).
    if (video.interpolation?.enabled !== true) delete video.interpolation;
    return {
      video,
      enabled: config.plugins['compress-videos']?.enabled,
      image: config.media.image,
    };
  }
  if (folder === 'music') return { audio: config.media.audio };
  return {
    image: config.imageQuality,
    placeholder: config.media.image,
    enabled: config.plugins['compress-images']?.enabled,
  };
}
