/**
 * Durable configuration-reconciliation batches. After a config save the
 * coordinator re-hashes every asset and queues a replacement task only when the
 * processing fingerprint actually changed; progress is persisted per asset so
 * an interrupted reconciliation resumes on the next alarm.
 */
import { fingerprint } from '../../../shared/media-manifest.mjs';
import { processingConfig } from '../../../shared/config.mjs';
import { registerAsset } from './media-task-ops.mjs';

/**
 * Process one reconciliation batch (mutates `state.reconcile`).
 * @param {object} context - coordinator task context (`state`, `env`, `config`, save/batch hooks)
 * @returns {Promise<{processed: number, done: boolean}>}
 */
export async function reconcileBatch({ state, env, config, saveManifest, batchManifest }) {
  if (!state.reconcile) return { processed: 0, done: true };
  let processed = 0;
  try {
    const ids = Object.keys(state.manifest.assets)
      .sort()
      .filter((id) => id > state.reconcile.after)
      .slice(0, config.media.reconcileBatchSize);
    await batchManifest(state, async () => {
      for (const id of ids) {
        const asset = state.manifest.assets[id];
        // A deleted/de-source asset cannot be reprocessed; never queue a dead task.
        if (asset.status !== 'deleted' && asset.source.available !== false) {
          const source = await env.MEDIA.head(asset.source.key);
          if (source)
            await registerAsset({
              state,
              data: {
                ...asset,
                source: { ...asset.source, etag: source.etag, size: source.size },
                config,
                force: state.reconcile.force,
                configHash: await fingerprint(processingConfig(config, asset.folder)),
              },
              env,
              config,
              saveManifest,
            });
        }
        state.reconcile.after = id;
        processed++;
      }
      if (ids.length < config.media.reconcileBatchSize) state.reconcile = null;
    });
    return { processed, done: !state.reconcile };
  } catch (error) {
    state.lastDispatchError = `Media reconciliation: ${error.message}`;
    return { processed, done: false };
  }
}
