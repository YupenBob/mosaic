/** Video composition root. Engines, controls and playlists have separate owners. */
import { VideoPlayer } from './video/player.js';
import { initPlaylistMode } from './video/playlist.js';
import { registry } from './video/registry.js';
let scope;
export function initVideoPlayers() {
  scope?.abort();
  registry.players.forEach((player) => player.destroy());
  registry.players = [];
  scope = new AbortController();
  document.addEventListener(
    'click',
    (event) => {
      for (const player of registry.players) {
        if (!player.speedBtn?.contains(event.target) && !player.speedMenu?.contains(event.target))
          player.speedMenu?.classList.remove('open');
        if (!player.qualityBtn?.contains(event.target) && !player.qualityMenu?.contains(event.target))
          player.qualityMenu?.classList.remove('open');
      }
    },
    { signal: scope.signal },
  );
  const wrap = document.querySelector('.video-playlist-wrap');
  if (wrap)
    initPlaylistMode(
      wrap,
      VideoPlayer,
      (value) => {
        registry.players = value;
      },
      scope.signal,
    );
  else
    document.querySelectorAll('.video-container').forEach((container, index, containers) => {
      if (container.querySelector('.video-element'))
        registry.players.push(new VideoPlayer(container, index, containers.length));
    });
  window.addEventListener(
    'pagehide',
    () => {
      registry.players.forEach((player) => player.destroy());
      scope.abort();
    },
    { signal: scope.signal },
  );
  return () => {
    registry.players.forEach((player) => player.destroy());
    scope.abort();
  };
}
