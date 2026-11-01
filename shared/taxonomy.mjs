/**
 * Category and tag identities shared by the static generator, the Worker and
 * the admin. Runtime-neutral: no filesystem, no SDK and no DOM dependencies.
 *
 * `taxonomyPartSlug` keeps the historical output (lowercase + whitespace→`-`)
 * so every already published route stays byte-identical; the new assertion
 * layer only *rejects* names that could escape the output directory or break a
 * path (`..`, `.`, empty segments, control characters, backslashes, overlong).
 */

/** A single tag or category level may not exceed this length. */
export const MAX_TAXONOMY_NAME_LENGTH = 120;
/** A nested category path must still fit comfortably in a filesystem path. */
export const MAX_CATEGORY_PATH_LENGTH = 240;

/**
 * True when the value contains C0/C1 control characters (same rule as
 * shared/media-manifest.mjs; implemented without a control-character regex).
 * @param {string} value
 * @returns {boolean}
 */
export function hasControlCharacter(value) {
  return [...String(value == null ? '' : value)].some((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

/** Raised when a category/tag name is unsafe to use as a route segment. */
export class TaxonomyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaxonomyError';
  }
}

/**
 * Slug of one taxonomy part. Identical to the historical inline expression
 * (`name.toLowerCase().replace(/\s+/g, '-')`) so existing routes do not move.
 * Callers that split a nested category must trim each part before calling.
 * @param {string} part
 * @returns {string}
 */
export function taxonomyPartSlug(part) {
  return String(part == null ? '' : part)
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function assertSegment(segment, label) {
  const trimmed = segment.trim();
  if (!trimmed) throw new TaxonomyError(`${label} must not contain empty path segments`);
  if (trimmed === '.' || trimmed === '..') throw new TaxonomyError(`${label} must not be "." or ".."`);
  if (trimmed.length > MAX_TAXONOMY_NAME_LENGTH)
    throw new TaxonomyError(`${label} segment is longer than ${MAX_TAXONOMY_NAME_LENGTH} characters`);
  if (hasControlCharacter(segment)) throw new TaxonomyError(`${label} must not contain control characters`);
  if (segment.includes('\\')) throw new TaxonomyError(`${label} must not contain backslashes`);
}

/**
 * Assert that a category or tag name is safe to turn into a route/path.
 * Returns the original name so it can wrap a value in one expression.
 * @param {unknown} name
 * @param {{kind?: 'category'|'tag'}} [options]
 * @returns {string}
 */
export function assertTaxonomyName(name, options = {}) {
  const kind = options.kind || 'tag';
  if (kind !== 'category' && kind !== 'tag') throw new TaxonomyError(`Unknown taxonomy kind "${kind}"`);
  if (typeof name !== 'string') throw new TaxonomyError(`${kind} must be a string`);
  if (kind === 'tag') {
    if (!name) throw new TaxonomyError('tag must not be empty');
    if (name.includes('/')) throw new TaxonomyError(`tag "${name}" must not contain "/"`);
    assertSegment(name, 'tag');
    return name;
  }
  if (!name) throw new TaxonomyError('category must not be empty');
  if (name.length > MAX_CATEGORY_PATH_LENGTH)
    throw new TaxonomyError(`category is longer than ${MAX_CATEGORY_PATH_LENGTH} characters`);
  for (const segment of name.split('/')) assertSegment(segment, 'category');
  return name;
}

/** True when `name` passes {@link assertTaxonomyName} for `kind`. */
export function isValidTaxonomyName(name, options = {}) {
  try {
    assertTaxonomyName(name, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Human-readable category levels in order (`"Tech / Web"` → `["Tech", "Web"]`).
 * Validates first, so a malformed category fails at the call site.
 * @param {string} category
 * @returns {string[]}
 */
export function categorySegments(category) {
  assertTaxonomyName(category, { kind: 'category' });
  return category.split('/').map((part) => part.trim());
}

/**
 * Output route of a category page, relative to `dist/categories/`.
 * `"parent/child/grandchild"` → `"parent/child/grandchild"`;
 * `"Tech / Web"` → `"tech/web"` (the old inline breadcrumb produced the
 * broken `"tech-/-web"` route).
 * @param {string} category
 * @returns {string}
 */
export function categoryRoute(category) {
  return categorySegments(category)
    .map((part) => taxonomyPartSlug(part))
    .join('/');
}

/**
 * Output route segment of a tag page, relative to `dist/tags/`.
 * @param {string} tag
 * @returns {string}
 */
export function tagSlug(tag) {
  assertTaxonomyName(tag, { kind: 'tag' });
  return taxonomyPartSlug(tag);
}
