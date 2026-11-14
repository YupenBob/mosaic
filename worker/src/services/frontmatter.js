import { load, dump } from 'js-yaml';

function invalidContent(message) {
  return Object.assign(new Error(message), { status: 422, code: 'INVALID_CONTENT' });
}

/** Split only the frontmatter envelope and its single separating blank line. */
export function parsePostContent(content) {
  const source = content.replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source);
  if (!match || match.index !== 0) return { frontMatter: {}, body: source };
  const frontMatter = load(match[1]) ?? {};
  if (typeof frontMatter !== 'object' || Array.isArray(frontMatter) || frontMatter instanceof Date) {
    throw invalidContent('Frontmatter must be a mapping');
  }
  return { frontMatter, body: source.slice(match[0].length).replace(/^\r?\n/, '') };
}

export function parseFrontMatter(content) {
  return parsePostContent(content).frontMatter;
}

const sentinels = new Set(['null', 'undefined', '[object Object]']);
const nullableFields = new Set(['category', 'description', 'cover']);

function normalizeValue(value, field, nullable = false) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (sentinels.has(trimmed)) {
      if (nullable) return null;
      throw invalidContent(`${field} must not contain a sentinel string`);
    }
    return trimmed;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, field));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeValue(item, `${field}.${key}`)]),
    );
  }
  return value;
}

function normalizeDate(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw invalidContent('date must be a valid ISO timestamp');
    return value.toISOString();
  }
  if (typeof value !== 'string') throw invalidContent('date must be a valid ISO timestamp');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const iso = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
    value,
  );
  // Date.parse rolls impossible days into the following month; reject those too.
  const calendarDate = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (
    (!dateOnly && !iso) ||
    !Number.isFinite(Date.parse(value)) ||
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== value.slice(0, 10)
  ) {
    throw invalidContent('date must be a valid ISO timestamp');
  }
  return dateOnly ? `${value}T00:00:00.000Z` : value;
}

/** Normalize the JSON admin payload without mutating the caller's object. */
export function normalizeFrontMatter(frontMatter) {
  if (!frontMatter || typeof frontMatter !== 'object' || Array.isArray(frontMatter) || frontMatter instanceof Date) {
    throw invalidContent('Frontmatter must be a mapping');
  }
  const normalized = Object.fromEntries(
    Object.entries(frontMatter)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, normalizeValue(value, key, nullableFields.has(key))]),
  );
  // Legacy posts may have no title (the build falls back to the slug); the admin
  // editor sends '' when the field is cleared, which the build also tolerates.
  if (normalized.title != null && typeof normalized.title !== 'string') {
    throw invalidContent('title must be a string');
  }
  if (typeof normalized.title === 'string') normalized.title = normalized.title.trim();
  if ('date' in normalized) normalized.date = normalizeDate(normalized.date);
  if ('tags' in normalized) {
    const tags = typeof normalized.tags === 'string' ? normalized.tags.split(',') : normalized.tags;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
      throw invalidContent('tags must be an array of strings or a comma-separated string');
    }
    normalized.tags = tags.map((tag) => normalizeValue(tag, 'tags')).filter(Boolean);
  }
  for (const key of ['views', 'likes']) {
    if (!(key in normalized)) continue;
    const value = normalized[key];
    const number = typeof value === 'string' && value !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
      throw invalidContent(`${key} must be a non-negative integer`);
    }
    normalized[key] = Math.trunc(number);
  }
  return normalized;
}

/** Serialize normalized metadata, preserving body whitespace and a final newline. */
export function serializePostContent(frontMatter, body = '') {
  const safeFields = Object.fromEntries(Object.entries(frontMatter).filter(([key]) => /^[A-Za-z0-9_-]+$/.test(key)));
  const yaml = dump(safeFields, { lineWidth: -1, noRefs: true, sortKeys: false });
  const text = body || '';
  return `---\n${yaml}---\n\n${text}${text && !text.endsWith('\n') ? '\n' : ''}`;
}
