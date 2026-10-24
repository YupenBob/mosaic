/**
 * Keyboard shortcuts for the post-page player (WCAG 2.1.1 / 2.2 level A).
 * Only acts when the player container (or a descendant) has focus; focus is
 * made possible by the container tabindex set in player.decorate().
 */
export const keyboardControls = {
  /**
   * @param {KeyboardEvent} event
   */
  handleKeyboard(event) {
    const player = this;
    const container = player.container;
    if (!container) return;
    if (!container.contains(document.activeElement) && document.activeElement !== document.body) return;
    if (event.target?.closest?.('input, textarea, select')) return;
    const video = player.video;
    const playback = player.playback;
    const seekBy = (delta) => {
      playback?.seek(video.currentTime + delta);
      player.showOverlay(delta < 0 ? `« ${Math.abs(delta)}s` : `${delta}s »`);
    };
    const volumeBy = (delta) => {
      video.muted = false;
      video.volume = Math.max(0, Math.min(1, Math.round((video.volume + delta) * 10) / 10));
      player.showOverlay(`音量 ${Math.round(video.volume * 100)}%`);
    };
    switch (event.key) {
      case ' ':
      case 'k':
        if (event.target?.closest?.('button, a')) return;
        event.preventDefault();
        player.togglePlay();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        seekBy(-5);
        break;
      case 'ArrowRight':
        event.preventDefault();
        seekBy(5);
        break;
      case 'j':
        event.preventDefault();
        seekBy(-10);
        break;
      case 'l':
        event.preventDefault();
        seekBy(10);
        break;
      case 'ArrowUp':
        event.preventDefault();
        volumeBy(0.1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        volumeBy(-0.1);
        break;
      case 'm':
        event.preventDefault();
        video.muted = !video.muted;
        player.showOverlay(video.muted ? '静音' : '取消静音');
        break;
      case 'f':
        event.preventDefault();
        player.toggleFullscreen();
        break;
      case 'n':
        event.preventDefault();
        player.switchToNextVideo();
        break;
      case 'Home':
        event.preventDefault();
        playback?.seek(0);
        break;
      case 'End':
        event.preventDefault();
        if (Number.isFinite(video.duration)) playback?.seek(video.duration);
        break;
      case 'Escape':
        player.speedMenu?.classList.remove('open');
        player.qualityMenu?.classList.remove('open');
        break;
      default:
        return;
    }
    player.showControls();
  },
};
