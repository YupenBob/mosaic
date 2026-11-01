/**
 * Single source of truth for deployment-time constants shared by build scripts,
 * the generated Worker configuration and the checked-in wrangler manifests.
 *
 * The wrangler TOML files cannot import JavaScript, so their literals are
 * mirrored here and verified by `scripts/check-wrangler-config.mjs`. Everything
 * that *can* import must use these constants instead of a local literal, so a
 * runtime bump is a one-line change plus a checker run.
 */

/** Runtime compatibility date of the Worker (`worker/src/index.js`). */
export const COMPATIBILITY_DATE = '2024-04-01';

/** Runtime compatibility date of the Cloud Admin Pages project Functions. */
export const ADMIN_COMPATIBILITY_DATE = '2025-06-01';

/** Exact wrangler version used in CI (`npm exec --prefix worker -- wrangler`). */
export const WRANGLER_VERSION = '3.114.17';

/**
 * Backoff between Pages deploy attempts, in milliseconds. The pipeline makes
 * one initial attempt plus one attempt per entry here, so a transient Pages or
 * network failure can never fail a content build on the first try.
 */
export const PAGES_DEPLOY_BACKOFF_MS = [15_000, 45_000, 120_000];

/** Total deploy attempts: the first try plus one retry per backoff entry. */
export const PAGES_DEPLOY_MAX_ATTEMPTS = PAGES_DEPLOY_BACKOFF_MS.length + 1;

/** Where a successful Pages deploy records its deployment id. */
export const DEPLOY_RECORD_PATH = '.mosaic/deploy.json';
