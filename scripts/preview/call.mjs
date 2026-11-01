/** Sign a preview-build Worker call with PIPELINE_SECRET (workflow only). */
import crypto from 'node:crypto';
import fs from 'node:fs';

const operation = process.argv[2];
if (!['draft', 'done'].includes(operation)) throw new Error('Usage: node call.mjs draft|done');
const target = (process.env.API_BASE || '').replace(/\/+$/, '');
const secret = process.env.PIPELINE_SECRET;
if (!target || !secret) throw new Error('API_BASE and PIPELINE_SECRET are required');
const previewId = process.env.PREVIEW_ID;
const draftId = process.env.DRAFT_ID;
if (!previewId || !draftId) throw new Error('PREVIEW_ID and DRAFT_ID are required');

const payload =
  operation === 'draft'
    ? { previewId, draftId }
    : { previewId, ok: process.env.PREVIEW_OK !== 'false', error: process.env.PREVIEW_ERROR || '' };
const raw = JSON.stringify(payload);
const timestamp = String(Date.now());
const nonce = crypto.randomBytes(16).toString('hex');
const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${raw}`).digest('hex');
const response = await fetch(`${target}/api/preview-build/${operation}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Mosaic-Time': timestamp,
    'X-Mosaic-Nonce': nonce,
    'X-Mosaic-Signature': signature,
  },
  body: raw,
});
const text = await response.text();
if (!response.ok) throw new Error(`Preview ${operation} failed: ${response.status} ${text}`);
if (operation === 'draft') {
  const file = process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/draft.json` : 'draft.json';
  fs.writeFileSync(file, text);
  console.log(`Preview draft written: ${file}`);
} else console.log(text);
