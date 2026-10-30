/**
 * R2-backed cloud drafts. One JSON record per draft, with the previous revision
 * snapshotted on each save. No Durable Object is needed: the revision check is
 * a compare-and-set performed inside the Worker, and the admin is single-user.
 */
import {
  draftKey,
  draftRevisionKey,
  MAX_DRAFT_BYTES,
  newDraftId,
  normalizeDraft,
  validDraftId,
  validateDraftRecord,
} from '../../../shared/drafts.mjs';
import { createOrUpdatePost } from './content.js';
import { markDirty } from './publication.js';

function notFound() {
  return Object.assign(new Error('Draft not found'), { status: 404, code: 'NOT_FOUND' });
}
function conflict() {
  return Object.assign(new Error('Draft changed elsewhere'), { status: 409, code: 'CONFLICT' });
}

async function read(c, id) {
  const object = await c.env.MEDIA.get(draftKey(id));
  if (!object) return null;
  return validateDraftRecord(JSON.parse(await object.text()));
}

async function write(c, draft) {
  const body = JSON.stringify(draft);
  if (new TextEncoder().encode(body).length > MAX_DRAFT_BYTES)
    throw Object.assign(new Error('Draft is too large'), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
  await c.env.MEDIA.put(draftKey(draft.id), body, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
}

export async function createDraft(c, input = {}) {
  const id = newDraftId();
  const now = new Date().toISOString();
  const draft = {
    ...normalizeDraft(input),
    id,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  await write(c, draft);
  return draft;
}

export async function getDraft(c, id) {
  if (!validDraftId(id)) throw Object.assign(new Error('Invalid draft id'), { status: 400 });
  const draft = await read(c, id);
  if (!draft) throw notFound();
  return draft;
}

export async function listDrafts(c) {
  const listed = await c.env.MEDIA.list({ prefix: 'drafts/', limit: 500 });
  const drafts = [];
  for (const object of listed.objects || []) {
    if (!object.key.endsWith('/current.json')) continue;
    const id = object.key.split('/')[1];
    if (!validDraftId(id)) continue;
    const draft = await read(c, id).catch(() => null);
    if (draft)
      drafts.push({
        id: draft.id,
        slug: draft.slug,
        title: draft.title,
        revision: draft.revision,
        updatedAt: draft.updatedAt,
        mediaCount:
          (draft.media?.gallery?.length || 0) + (draft.media?.videos?.length || 0) + (draft.media?.music?.length || 0),
      });
  }
  drafts.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return drafts;
}

export async function saveDraft(c, id, input = {}) {
  if (!validDraftId(id)) throw Object.assign(new Error('Invalid draft id'), { status: 400 });
  const current = await read(c, id);
  if (!current) throw notFound();
  const expected = Number(input.revision);
  if (Number.isInteger(expected) && expected !== current.revision) throw conflict();
  const next = {
    ...current,
    ...normalizeDraft(input, current),
    id,
    revision: current.revision + 1,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  // Snapshot the previous version before replacing current.
  await c.env.MEDIA.put(draftRevisionKey(id, current.revision), JSON.stringify(current), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
  await write(c, next);
  return next;
}

export async function deleteDraft(c, id) {
  if (!validDraftId(id)) throw Object.assign(new Error('Invalid draft id'), { status: 400 });
  const current = await read(c, id);
  if (!current) throw notFound();
  const listed = await c.env.MEDIA.list({ prefix: `drafts/${id}/`, limit: 1000 });
  const keys = (listed.objects || []).map((object) => object.key);
  if (keys.length) await c.env.MEDIA.delete(keys);
  return { ok: true };
}

/**
 * Publish a draft into Git. `baseSha` makes this an optimistic update for an
 * existing post; `null` means create-only. The draft is deleted only after the
 * commit succeeds.
 */
export async function publishDraft(c, id) {
  if (!validDraftId(id)) throw Object.assign(new Error('Invalid draft id'), { status: 400 });
  const draft = await read(c, id);
  if (!draft) throw notFound();
  if (!draft.slug) throw Object.assign(new Error('Draft has no slug'), { status: 400, code: 'INVALID_PARAMS' });
  const result = await createOrUpdatePost(
    c,
    draft.slug,
    draft.frontMatter || {},
    draft.body || '',
    `Publish draft ${id}`,
    draft.baseSha,
  );
  await markDirty(c.env, result.commit?.sha || '');
  await deleteDraft(c, id);
  return { ok: true, slug: draft.slug, sha: result.content?.sha };
}
