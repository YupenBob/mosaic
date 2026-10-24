/**
 * Visual feedback channel for the player: buffering state, transient gesture
 * overlays and the fatal-error retry card. Kept separate from event binding so
 * every module can report user-facing state without owning listeners.
 */
export const feedbackControls = {
  /** Show a transient centered overlay (seek amount, speed, volume). */
  showOverlay(html, duration = 1200) {
    if (!this.container) return;
    let element = this.container.querySelector('.video-key-overlay');
    if (!element) {
      element = document.createElement('div');
      element.className = 'video-key-overlay';
      element.setAttribute('aria-hidden', 'true');
      this.container.appendChild(element);
    }
    element.innerHTML = html;
    element.style.opacity = '1';
    clearTimeout(this._overlayTimer);
    this._overlayTimer = setTimeout(() => {
      element.style.opacity = '0';
    }, duration);
  },

  setBuffering(buffering) {
    this.container.classList.toggle('buffering', !!buffering);
    this.container.setAttribute('aria-busy', buffering ? 'true' : 'false');
  },

  /** Human message for a controller/media error. */
  errorMessage(error) {
    const details = String(error?.details || error?.type || '');
    if (/no-|unavailable|no-playable|no-progressive/.test(details)) return '视频源不可用，请稍后重试';
    if (/network|manifest|load/i.test(details)) return '网络异常，视频加载失败';
    if (/media|decode/i.test(details)) return '视频解码失败，请重试';
    return '视频播放失败，请重试';
  },

  /** Fatal, unrecoverable error card with a retry action. */
  showError(error) {
    if (!this.container) return;
    let box = this.container.querySelector('.video-error');
    if (!box) {
      box = document.createElement('div');
      box.className = 'video-error';
      box.setAttribute('role', 'alert');
      box.innerHTML =
        '<div class="video-error-card">' +
        '<i class="ri-error-warning-line" aria-hidden="true"></i>' +
        '<p class="video-error-message"></p>' +
        '<button class="video-error-retry" type="button">重试</button>' +
        '</div>';
      box.querySelector('.video-error-retry').addEventListener('click', (event) => {
        event.stopPropagation();
        this.clearError();
        this.playback?.play();
      });
      this.container.appendChild(box);
    }
    const message = box.querySelector('.video-error-message');
    if (message) message.textContent = this.errorMessage(error);
    box.classList.add('show');
    this.setBuffering(false);
  },

  clearError() {
    this.container?.querySelector('.video-error')?.classList.remove('show');
  },
};
