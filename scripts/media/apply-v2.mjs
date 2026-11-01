/**
 * Apply a Media v2 plan through injected effects. Keeping this pure-ish makes
 * the destructive path testable without R2/GitHub credentials.
 */
export function uniqueCopies(plan) {
  return [...new Map(plan.copies.filter((copy) => copy.from).map((copy) => [copy.to, copy])).values()];
}

/**
 * @param {object} options
 * @param {object} options.plan - result of planV2Migration
 * @param {(from:string,to:string)=>Promise<void>} options.copy
 * @param {(to:string)=>Promise<boolean>} [options.head] - destination existence probe;
 *   a copy whose target already exists is skipped, so a re-run after a partial
 *   migration only copies what is genuinely missing.
 * @param {(assets:object[])=>Promise<void>} options.importAssets
 * @param {(post:object)=>Promise<void>} [options.rewritePost] - optional per-post
 *   effect; the CLI rewrites every post in one Git commit instead.
 * @param {(value:object)=>Promise<void>} [options.writeMarker]
 * @param {number} [options.batchSize]
 */
export async function applyV2Migration({
  plan,
  copy,
  head,
  importAssets,
  rewritePost = async () => {},
  writeMarker = async () => {},
  batchSize = 25,
}) {
  const copies = uniqueCopies(plan);
  let copied = 0;
  let skippedCopies = 0;
  for (const entry of copies) {
    if (head && (await head(entry.to))) {
      skippedCopies++;
      continue;
    }
    await copy(entry.from, entry.to);
    copied++;
  }
  for (let offset = 0; offset < plan.assets.length; offset += batchSize) {
    await importAssets(plan.assets.slice(offset, offset + batchSize));
  }
  let posts = 0;
  for (const post of plan.posts) {
    await rewritePost(post);
    posts++;
  }
  const summary = { assets: plan.assets.length, copies: copied, posts };
  // Only surfaced when a re-run actually skipped work, keeping the original
  // summary shape for callers/tests that never probe destinations.
  if (skippedCopies) summary.skippedCopies = skippedCopies;
  await writeMarker({ completedAt: new Date().toISOString(), ...summary });
  return summary;
}
