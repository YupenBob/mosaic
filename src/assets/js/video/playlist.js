/**
 * Playlist mode: one mounted player at a time inside `.video-playlist-wrap`,
 * page-level item panel synced, auto-advance on end exactly once per video.
 * The controller owns decode; this module only decides which container mounts.
 */
const ADVANCE_GUARD_MS = 600;

/**
 * @param {HTMLElement} wrap `.video-playlist-wrap`
 * @param {new (container: HTMLElement, index: number, total: number) => object} VideoPlayer
 * @param {(players: object[]) => void} setPlayers
 * @param {AbortSignal} signal composition-root lifetime
 */
export function initPlaylistMode(wrap, VideoPlayer, setPlayers, signal) {
  const containers = [...wrap.querySelectorAll('.video-container')];
  const items = document.querySelectorAll('.post-playlist-panel .pl-item, .video-playlist-wrap .pl-item');
  const toggle = wrap.querySelector('.playlist-bar-toggle');
  const bar = wrap.querySelector('.playlist-bar');
  const total = containers.length;
  let currentIndex = -1;
  let currentPlayer = null;
  let lastAdvanceAt = 0;

  function showVideo(index, options = {}) {
    if (index < 0 || index >= total) return;
    currentPlayer?.destroy();
    containers.forEach((container, position) => {
      container.style.display = position === index ? '' : 'none';
      container.classList.toggle('active', position === index);
    });
    items.forEach((item, position) => item.classList.toggle('active', position === index));
    currentIndex = index;
    const container = containers[index];
    currentPlayer = container.querySelector('.video-element') ? new VideoPlayer(container, index, total) : null;
    setPlayers(currentPlayer ? [currentPlayer] : []);
    if (options.play && currentPlayer) currentPlayer.startLoading();
  }

  /** Auto-advance exactly once per ended video (guards duplicate events). */
  function advance() {
    const now = Date.now();
    if (now - lastAdvanceAt < ADVANCE_GUARD_MS) return;
    lastAdvanceAt = now;
    if (total < 1) return;
    showVideo((currentIndex + 1) % total, { play: true });
  }

  toggle?.addEventListener('click', () => bar?.classList.toggle('open'), { signal });
  items.forEach((item) => {
    item.addEventListener(
      'click',
      () => {
        const index = parseInt(item.dataset.index, 10);
        if (Number.isInteger(index) && index !== currentIndex) showVideo(index);
      },
      { signal },
    );
  });
  wrap.addEventListener('video-ended', advance, { signal });
  signal.addEventListener(
    'abort',
    () => {
      currentPlayer?.destroy();
      currentPlayer = null;
    },
    { once: true },
  );

  showVideo(0);
  return {
    showVideo,
    next: advance,
    get current() {
      return currentPlayer;
    },
  };
}
