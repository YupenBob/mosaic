/**
 * Cloud draft primitives. Drafts live in R2, not Git: they can autosave often
 * without polluting commit history, and publishing is an explicit action.
 */
export const DRAFT_SCHEMA_VERSION = 1;
export const DRAFT_ID_RE = /^drf_[a-z0-9]{26}$/;
export const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function newDraftId() {
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  let id = 'drf_';
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

export function draftKey(id) {
  return `drafts/${id}/current.json`;
}

export function draftRevisionKey(id, revision) {
  return `drafts/${id}/revisions/${revision}.json`;
}

export function validDraftId(id) {
  return typeof id === 'string' && DRAFT_ID_RE.test(id);
}

/**
 * Normalize untrusted draft input. Text is bounded by the route-level byte
 * check; this keeps the shape stable and drops unknown fields.
 */
export function normalizeDraft(input = {}, base = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const frontMatter =
    source.frontMatter && typeof source.frontMatter === 'object' && !Array.isArray(source.frontMatter)
      ? source.frontMatter
      : base.frontMatter || {};
  const media =
    source.media && typeof source.media === 'object' && !Array.isArray(source.media)
      ? {
          gallery: Array.isArray(source.media.gallery)
            ? source.media.gallery.filter((id) => typeof id === 'string')
            : [],
          videos: Array.isArray(source.media.videos) ? source.media.videos.filter((id) => typeof id === 'string') : [],
          music: Array.isArray(source.media.music) ? source.media.music.filter((id) => typeof id === 'string') : [],
          cover: typeof source.media.cover === 'string' ? source.media.cover : null,
        }
      : base.media || { gallery: [], videos: [], music: [], cover: null };
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    title: String(source.title ?? base.title ?? '').slice(0, 500),
    slug: String(source.slug ?? base.slug ?? '').slice(0, 200),
    body: String(source.body ?? base.body ?? ''),
    frontMatter,
    media,
    baseSha: source.baseSha === null ? null : (source.baseSha ?? base.baseSha ?? null),
  };
}

export function validateDraftRecord(value) {
  if (!value || value.schemaVersion !== DRAFT_SCHEMA_VERSION || !validDraftId(value.id))
    throw new Error('Invalid draft record');
  if (!Number.isInteger(value.revision) || value.revision < 1) throw new Error('Invalid draft revision');
  if (typeof value.updatedAt !== 'string') throw new Error('Invalid draft timestamp');
  return value;
}
