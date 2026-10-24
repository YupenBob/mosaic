/**
 * Composition-root registry: indexed players (null for lazy, not-yet-mounted
 * containers) plus the mount hook used by the "next video" control.
 */
export const registry = {
  /** @type {Array<import('./player.js').VideoPlayer|null>} */
  players: [],
  /** @type {((index: number) => import('./player.js').VideoPlayer|null)|null} */
  mountAt: null,
};
