/**
 * Post frontmatter schema shared by the static generator and the Worker.
 *
 * The generator (`scripts/site/posts.mjs`, `scripts/validate-config.mjs`) and
 * the Worker (`listPosts`, content overlay) must agree on what a valid post is;
 * keeping the rules here means a document accepted by one side is accepted by
 * the other, and an unsafe category/tag fails everywhere instead of only when
 * it reaches the filesystem.
 *
 * Runtime-neutral: no filesystem, no Node-only imports.
 */
import { assertTaxonomyName, hasControlCharacter, isValidTaxonomyName } from './taxonomy.mjs';
import { validSegment } from './media-manifest.mjs';

/** Content-block placeholders supported by the generator. */
export const CONTENT_BLOCK_TYPES = ['text', 'gallery', 'videos', 'music', 'photo', 'video'];
/** Video layout modes; anything else silently falls back to `stacked`. */
export const VIDEO_MODES = ['stacked', 'playlist'];

/** Raised when frontmatter violates the shared schema. */
export class ContentSchemaError extends Error {
  constructor(errors) {
    super(Array.isArray(errors) ? errors.join('; ') : String(errors));
    this.name = 'ContentSchemaError';
    this.errors = Array.isArray(errors) ? errors : [String(errors)];
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate parsed frontmatter data (gray-matter/`data` in the generator, the
 * object returned by `parseFrontMatter` in the Worker).
 *
 * Errors are hard failures (build/API must reject); warnings keep the
 * historical lenient behavior for optional cosmetic fields.
 *
 * @param {Record<string, unknown>} data
 * @param {{slug?: string}} [options] `slug` (the post directory name) is
 *   validated too when provided.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateFrontmatter(data, options = {}) {
  const errors = [];
  const warnings = [];
  const slug = options.slug == null ? '' : String(options.slug);

  if (!isPlainObject(data)) return { errors: ['frontmatter must be a mapping'], warnings };
  if (slug && !validSegment(slug)) errors.push(`invalid post slug "${slug}"`);

  if (data.title != null) {
    if (typeof data.title !== 'string') errors.push('title must be a string');
    else if (hasControlCharacter(data.title)) errors.push('title must not contain control characters');
  }

  if (data.date != null && Number.isNaN(new Date(data.date).getTime()))
    errors.push(`date "${String(data.date)}" is not parseable`);

  if (data.description != null) {
    if (typeof data.description !== 'string') errors.push('description must be a string');
    else if (hasControlCharacter(data.description)) errors.push('description must not contain control characters');
  }

  if (data.category != null) {
    if (typeof data.category !== 'string') errors.push('category must be a string');
    else if (!isValidTaxonomyName(data.category, { kind: 'category' }))
      errors.push(
        `category "${data.category}" is not a safe category name: ${taxonomyReason(data.category, 'category')}`,
      );
  }

  if (data.tags != null) {
    if (!Array.isArray(data.tags)) errors.push('tags must be an array of strings');
    else {
      for (const tag of data.tags) {
        if (typeof tag !== 'string') {
          errors.push('tags must be an array of strings');
          continue;
        }
        if (!isValidTaxonomyName(tag, { kind: 'tag' }))
          errors.push(`tag "${tag}" is not a safe tag name: ${taxonomyReason(tag, 'tag')}`);
      }
      if (new Set(data.tags).size !== data.tags.length) warnings.push('tags contain duplicates');
    }
  }

  if (data.cover != null) {
    if (typeof data.cover !== 'string') errors.push('cover must be a string');
    else if (hasControlCharacter(data.cover)) errors.push('cover must not contain control characters');
  }

  if (data.media != null && !isPlainObject(data.media)) errors.push('media must be an object');

  if (data.video_mode != null && !VIDEO_MODES.includes(data.video_mode))
    errors.push(`video_mode must be one of ${VIDEO_MODES.join(', ')}`);

  if (data.blocks != null) {
    if (
      !Array.isArray(data.blocks) ||
      data.blocks.some((block) => typeof block !== 'string' || !CONTENT_BLOCK_TYPES.includes(block))
    )
      warnings.push(`blocks must be an array of ${CONTENT_BLOCK_TYPES.join('/')} (ignored)`);
  }

  for (const key of ['views', 'likes', 'dwell_time']) {
    if (data[key] != null && (typeof data[key] !== 'number' || !Number.isFinite(data[key]) || data[key] < 0))
      errors.push(`${key} must be a non-negative number`);
  }

  return { errors, warnings };
}

/** Convenience wrapper: the hard failures only. */
export function frontmatterErrors(data, options = {}) {
  return validateFrontmatter(data, options).errors;
}

/**
 * Validate and return `data`, throwing {@link ContentSchemaError} when the
 * schema is violated (build scripts and Worker write paths use this).
 * @template T
 * @param {T} data
 * @param {{slug?: string, label?: string}} [options]
 * @returns {T}
 */
export function assertValidFrontmatter(data, options = {}) {
  const { errors } = validateFrontmatter(data, options);
  if (errors.length) {
    const label = options.label || options.slug || 'frontmatter';
    throw new ContentSchemaError(errors.map((error) => `${label}: ${error}`));
  }
  return data;
}

/** Reason text of a taxonomy rejection, reused in schema error messages. */
function taxonomyReason(name, kind) {
  try {
    assertTaxonomyName(name, { kind });
    return 'invalid';
  } catch (error) {
    return error.message || String(error);
  }
}
