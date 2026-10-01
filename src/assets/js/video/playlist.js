/** Playlist instances own their player resources. */
export function initPlaylistMode(wrap, VideoPlayer, setPlayers, signal) {
  let advanceTimer;
  const containers = wrap.querySelectorAll('.video-container');
  // Items may be in wrap (old inline) or in page-level .post-playlist-panel
  const items = document.querySelectorAll('.post-playlist-panel .pl-item, .video-playlist-wrap .pl-item');
  const toggle = wrap.querySelector('.playlist-bar-toggle');
  const bar = wrap.querySelector('.playlist-bar');
  const total = containers.length;
  let currentIdx = 0;
  let currentPlayer = null;

  function showVideo(idx) {
    if (currentPlayer) currentPlayer.destroy();
    containers.forEach((c, i) => {
      c.style.display = i === idx ? '' : 'none';
    });
    items.forEach((it, i) => it.classList.toggle('active', i === idx));
    currentIdx = idx;
    currentPlayer = containers[idx].querySelector('.video-element')
      ? new VideoPlayer(containers[idx], idx, total)
      : null;
    setPlayers(currentPlayer ? [currentPlayer] : []);
  }

  // Toggle playlist open/close
  toggle?.addEventListener('click', () => bar?.classList.toggle('open'), { signal });
  signal.addEventListener(
    'abort',
    () => {
      clearTimeout(advanceTimer);
      currentPlayer?.destroy();
    },
    { once: true },
  );

  // Init first video
  showVideo(0);

  items.forEach((item) => {
    item.addEventListener(
      'click',
      () => {
        const idx = parseInt(item.dataset.index);
        if (idx !== currentIdx) showVideo(idx);
      },
      { signal },
    );
  });

  // Auto-advance
  wrap.addEventListener(
    'video-ended',
    () => {
      const next = (currentIdx + 1) % total;
      showVideo(next);
      clearTimeout(advanceTimer);
      advanceTimer = setTimeout(() => {
        if (currentPlayer) currentPlayer.video.play()?.catch(() => {});
      }, 300);
    },
    { signal },
  );
}
