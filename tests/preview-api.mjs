/**
 * Preview tokens, R2 preview serving and workflow status metadata.
 * The workflow itself is exercised by Actions; this covers the Worker contract.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRuntime } from './helpers/runtime.mjs';
import { createDraft } from '../worker/src/services/drafts.js';
import {
  cleanupPreviews,
  createPreview,
  finishPreview,
  getPreviewStatus,
  readPreviewDraft,
  servePreview,
  signPreviewToken,
  verifyPreviewToken,
} from '../worker/src/services/preview.js';
import { verifyPipelineSignature } from '../worker/src/services/pipeline-signature.js';

const runtime = createRuntime();
runtime.env.PREVIEW_SECRET = 'preview-secret';
const context = {
  env: runtime.env,
  req: { url: 'https://api.example.com/api/previews' },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('/actions/workflows/')) return new Response(null, { status: 204 });
  return new Response('not found', { status: 404 });
};
try {
  const draft = await createDraft(context, { slug: 'preview-post', title: 'Preview', body: 'Draft body' });
  const preview = await createPreview(context, draft.id);
  assert.match(preview.previewId, /^prv_[a-z0-9]{26}$/);
  assert.ok(preview.token);
  assert.equal(preview.status, 'queued');
  assert.equal((await getPreviewStatus(context, preview.previewId)).status, 'queued');

  const checked = await verifyPreviewToken(preview.token, runtime.env.PREVIEW_SECRET);
  assert.equal(checked.p, preview.previewId);
  assert.equal(await verifyPreviewToken(preview.token, 'wrong-secret'), null);

  const expired = await signPreviewToken({ p: preview.previewId, exp: Date.now() - 1000 }, runtime.env.PREVIEW_SECRET);
  assert.equal(await verifyPreviewToken(expired, runtime.env.PREVIEW_SECRET), null);

  const fetched = await readPreviewDraft(context, { previewId: preview.previewId, draftId: draft.id });
  assert.equal(fetched.draft.id, draft.id);
  assert.equal(fetched.previewId, preview.previewId);
  await assert.rejects(
    () => readPreviewDraft(context, { previewId: preview.previewId, draftId: 'drf_0123456789abcdefghjkmnpq' }),
    (error) => error.status === 403,
  );

  const raw = JSON.stringify({ previewId: preview.previewId, draftId: draft.id });
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac('sha256', runtime.env.PIPELINE_SECRET)
    .update(`${timestamp}.${raw}`)
    .digest('hex');
  const signedContext = {
    env: runtime.env,
    req: { header: (name) => (name === 'X-Mosaic-Time' ? timestamp : name === 'X-Mosaic-Signature' ? signature : '') },
  };
  assert.equal(await verifyPipelineSignature(signedContext, raw), true);
  assert.equal(await verifyPipelineSignature(signedContext, `${raw}x`), false);

  await runtime.bucket.put(`previews/${preview.previewId}/index.html`, '<h1>preview</h1>');
  const response = await servePreview(context, preview.token, '');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /preview/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');

  await finishPreview(context, { previewId: preview.previewId, ok: true });
  assert.equal((await getPreviewStatus(context, preview.previewId)).status, 'ready');
  assert.equal((await cleanupPreviews(context)).deleted, 0, 'unexpired preview is kept');
  const meta = JSON.parse(await (await runtime.bucket.get(`previews/${preview.previewId}/meta.json`)).text());
  meta.expiresAt = new Date(Date.now() - 1000).toISOString();
  await runtime.bucket.put(`previews/${preview.previewId}/meta.json`, JSON.stringify(meta));
  assert.equal((await cleanupPreviews(context)).deleted, 1);
  assert.equal(await runtime.bucket.get(`previews/${preview.previewId}/index.html`), null);

  console.log('Preview API: token, draft read, R2 serving and status passed');
} finally {
  globalThis.fetch = realFetch;
}
