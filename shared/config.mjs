/** Runtime-neutral configuration shared by the generator and Worker. */
export const DEFAULTS = {
  language: 'zh-CN',
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

export function validateConfig(config) {
  const errors = [];
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
  if (folder === 'videos')
    return {
      video: config.videoQuality,
      enabled: config.plugins['compress-videos']?.enabled,
      image: config.media.image,
    };
  if (folder === 'music') return { audio: config.media.audio };
  return {
    image: config.imageQuality,
    placeholder: config.media.image,
    enabled: config.plugins['compress-images']?.enabled,
  };
}
