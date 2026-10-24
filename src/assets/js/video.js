/**
 * Video composition root. Keeps `initVideoPlayers()` as the public entry point
 * used by app.js:
 * - mounts players lazily when their container approaches the viewport
 *   (IntersectionObserver, 240px pre-roll) so a page with many videos creates a
 *   single decode pipeline for the one the user actually watches;
 * - playlist pages keep one mounted player and advance on `video-ended`;
 * - pagehide tears everything down, bfcache restores keep live players.
 */
import { VideoPlayer } from './video/player.js';
import { initPlaylistMode } from './video/playlist.js';
import { registry } from './video/registry.js';

let scope = null;
let observer = null;

function closeMenus(event) {
  for (const player of registry.players || []) {
    if (!player) continue;
    if (!player.speedBtn?.contains(event.target) && !player.speedMenu?.contains(event.target)) {
      player.speedMenu?.classList.remove('open');
      player.speedBtn?.setAttribute('aria-expanded', 'false');
    }
    if (!player.qualityBtn?.contains(event.target) && !player.qualityMenu?.contains(event.target)) {
      player.qualityMenu?.classList.remove('open');
      player.qualityBtn?.setAttribute('aria-expanded', 'false');
    }
  }
}

function disposePlayers() {
  for (const player of registry.players || []) {
    try {
      player?.destroy();
    } catch (error) {
      console.error('[Video] player dispose failed:', error);
    }
  }
  registry.players = [];
  registry.mountAt = null;
  observer?.disconnect();
  observer = null;
}

function mountLazily(containers, mount) {
  const targets = containers
    .map((container, index) => ({ container, index }))
    .filter(({ container }) => container.querySelector('.video-element'));
  if (typeof IntersectionObserver !== 'function') {
    targets.forEach(({ index }) => mount(index));
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer?.unobserve(entry.target);
        const index = containers.indexOf(entry.target);
        if (index >= 0) mount(index);
      }
    },
    { rootMargin: '240px 0px' },
  );
  targets.forEach(({ container }) => observer.observe(container));
}

/**
 * Initialize every video on the page (idempotent, returns a dispose function).
 * @returns {() => void}
 */
export function initVideoPlayers() {
  scope?.abort();
  disposePlayers();
  scope = new AbortController();
  const signal = scope.signal;
  const containers = [...document.querySelectorAll('.video-container')];
  for (const container of containers) delete container.dataset.playerMounted;
  registry.players = new Array(containers.length).fill(null);

  const mount = (index) => {
    const container = containers[index];
    if (!container) return null;
    if (container.dataset.playerMounted === 'true') return registry.players[index] || null;
    if (!container.querySelector('.video-element')) return null;
    try {
      registry.players[index] = new VideoPlayer(container, index, containers.length);
      container.dataset.playerMounted = 'true';
    } catch (error) {
      delete container.dataset.playerMounted;
      console.error('[Video] player mount failed:', error);
      return null;
    }
    return registry.players[index];
  };
  registry.mountAt = mount;

  document.addEventListener('click', closeMenus, { signal });

  const wrap = document.querySelector('.video-playlist-wrap');
  if (wrap) {
    initPlaylistMode(
      wrap,
      VideoPlayer,
      (players) => {
        registry.players = players;
      },
      signal,
    );
  } else {
    mountLazily(containers, mount);
  }

  // Leave-time hygiene: persist/stop decode (controller listeners) then dispose.
  window.addEventListener(
    'pagehide',
    (event) => {
      if (event.persisted) return; // bfcache keeps the live pipeline
      disposePlayers();
      scope?.abort();
    },
    { signal },
  );

  const dispose = () => {
    scope?.abort();
    disposePlayers();
    scope = null;
  };
  return dispose;
}
