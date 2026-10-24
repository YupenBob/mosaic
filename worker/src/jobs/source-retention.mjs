/**
 * Best-effort deletion of `originals/...` after a keepSource=false video task
 * is fully published. Runs inside the coordinator's serialized `publish`
 * handler, so it can never race a replacement upload: the caller has already
 * verified that the asset generation is still the job's generation. A deletion
 * failure is recorded but never fails the media task (published output is
 * already valid and must not be rolled back).
 */
import { sourceRetentionEligible } from './media-options.mjs';

/**
 * @typedef {{deleted:boolean, skipped?:string, error?:string, deletedAt?:string}} SourceRetentionResult
 */

/**
 * Attempt to delete the original source object for a fully published task.
 * @param {object} options
 * @param {object} options.env - Worker env (R2 binding `MEDIA`)
 * @param {object} options.job - job that just published
 * @param {object} options.asset - manifest asset for the job
 * @param {boolean} options.complete - whether every tier is published
 * @returns {Promise<SourceRetentionResult>}
 */
export async function applySourceRetention({ env, job, asset, complete }) {
  if (complete !== true) return { deleted: false, skipped: 'incomplete' };
  if (!sourceRetentionEligible(job, asset)) return { deleted: false, skipped: 'not-eligible' };
  // A newer upload replaced the object between claim and publish: never delete it.
  try {
    const current = await env.MEDIA.head(job.source.key);
    if (current && job.source.etag && current.etag !== job.source.etag)
      return { deleted: false, skipped: 'source-replaced' };
    if (!current) return { deleted: false, skipped: 'source-missing' };
    await env.MEDIA.delete(job.source.key);
  } catch (error) {
    return { deleted: false, error: String(error.message || error) };
  }
  const deletedAt = new Date().toISOString();
  // Metadata-only change: the published outputs are untouched, so no manifest
  // revision bump / site build is triggered here.
  asset.source = { ...asset.source, available: false, deletedAt };
  asset.sourceDeletedAt = deletedAt;
  job.source = asset.source;
  return { deleted: true, deletedAt };
}
