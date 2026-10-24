/**
 * Normalization and projections for per-task media options (`keepSource`,
 * `sourceMode`, `interpolation`). Options are persisted by the Jobs DO and
 * returned to the media runner and admin UI; the legacy payloads without
 * `options` keep working (sourceMode defaults to `original`).
 */
import { DEFAULTS, mergeInterpolation, validateInterpolation } from '../../../shared/config.mjs';

/**
 * Parse a boolean-ish transport value (query string, header or JSON body).
 * @param {unknown} value
 * @returns {boolean|undefined} undefined when the value is absent/ambiguous
 */
export function parseKeepSource(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return undefined;
}

/**
 * Resolve keepSource against the site default.
 * @param {unknown} value - explicit per-upload/per-task value
 * @param {object} [config] - normalized site config
 * @returns {boolean}
 */
export function resolveKeepSource(value, config = DEFAULTS) {
  const explicit = parseKeepSource(value);
  if (explicit !== undefined) return explicit;
  return config.media?.keepSourceFiles !== false;
}

/**
 * Validate + normalize an interpolation override. Invalid overrides are
 * dropped (an upload must never fail because of a bad optional option).
 * @param {unknown} value
 * @returns {object|undefined}
 */
export function normalizeInterpolationOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const merged = mergeInterpolation({ enabled: false }, value);
  return validateInterpolation(merged).length ? undefined : merged;
}

/**
 * Normalize the `options` payload stored on a job.
 * @param {unknown} options - raw options from upload registration / API
 * @param {object} [config] - normalized site config
 * @returns {{keepSource:boolean, sourceMode?:string, interpolation?:object}}
 */
export function normalizeJobOptions(options, config = DEFAULTS) {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  /** @type {{keepSource:boolean, sourceMode?:string, interpolation?:object}} */
  const normalized = { keepSource: resolveKeepSource(source.keepSource, config) };
  if (source.sourceMode === 'processed') normalized.sourceMode = 'processed';
  const interpolation = normalizeInterpolationOptions(source.interpolation);
  if (interpolation) normalized.interpolation = interpolation;
  return normalized;
}

/**
 * @param {object} [job]
 * @returns {boolean}
 */
export function isProcessedMode(job) {
  return job?.options?.sourceMode === 'processed';
}

/**
 * Project a persisted job for `jobs-list` / `job` responses: internal config,
 * lease and (bulk) checkpoint/source payloads are stripped, while the option
 * shapes and source-retention state the admin needs are added.
 * @param {object} job
 * @param {object} [asset]
 * @returns {object}
 */
export function publicJobView(job, asset) {
  const { config: _config, lease: _lease, processedSources: _processedSources, ...view } = job;
  return {
    ...view,
    options: job.options || {},
    published: !!asset?.published,
    sourceAvailable: asset?.source?.available !== false,
    sourceDeletedAt: asset?.sourceDeletedAt || asset?.source?.deletedAt || null,
  };
}

/**
 * @param {object} job
 * @param {object} asset
 * @returns {boolean} true when the runner's final publish may delete originals
 */
export function sourceRetentionEligible(job, asset) {
  return (
    job.folder === 'videos' &&
    job.options?.keepSource === false &&
    !!job.source?.key?.startsWith('originals/') &&
    asset?.source?.available !== false &&
    asset?.status !== 'deleted' &&
    asset?.generation === job.generation
  );
}
