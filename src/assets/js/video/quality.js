/**
 * Quality menu for the post-page player.
 *
 * The menu is a projection of the decode controller state: it lists exactly the
 * published tiers/manifest levels (never invented ones), shows real resolution
 * and bitrate when hls.js reports it, exposes `Auto` only when adaptive
 * selection exists, and keeps the manual/automatic lock in the controller.
 */
import { formatBitrate } from './tune.js';

export const qualityControls = {
  /** Rebuild the dropdown from the controller levels (or published MP4 tiers). */
  buildQualityMenu() {
    if (!this.qualityMenu) return;
    const playback = this.playback;
    const adaptive = playback?.mode === 'hls';
    const levels = playback?.levels?.length
      ? playback.levels
      : Object.keys(this.sources || {}).map((label) => ({ label, height: 0, bitrate: 0, detail: '' }));
    this.qualityMenu.innerHTML = '';
    this.qualityMenu.setAttribute('role', 'menu');
    this.qualityMenu.setAttribute('aria-label', '视频清晰度');
    if (adaptive) {
      this.qualityMenu.appendChild(this._qualityButton('Auto', 'auto'));
    }
    for (const level of levels) {
      if (!level?.label) continue;
      const detail = level.detail || formatBitrate(level.bitrate);
      const button = this._qualityButton(level.label, level.label, detail);
      button.dataset.res = level.label;
      this.qualityMenu.appendChild(button);
    }
    this.qualityMenu.hidden = this.qualityMenu.children.length === 0;
    this.updateQualityActive();
  },

  _qualityButton(label, value, detail = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitemradio');
    button.dataset.res = value;
    button.innerHTML =
      `<span class="vc-quality-label">${label}</span>` +
      (detail ? `<span class="vc-quality-detail">${detail}</span>` : '');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.switchResolution(value);
      this.qualityMenu.classList.remove('open');
      if (this.qualityBtn) this.qualityBtn.setAttribute('aria-expanded', 'false');
    });
    return button;
  },

  /** Reflect the active tier on the button and menu items. */
  updateQualityActive(level) {
    const playback = this.playback;
    const manual = playback?.quality && playback.quality !== 'auto' ? playback.quality : 'auto';
    const active = manual === 'auto' ? 'auto' : level?.label || manual;
    if (this.qualityMenu) {
      for (const button of this.qualityMenu.querySelectorAll('button')) {
        const isActive = button.dataset.res === active;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-checked', isActive ? 'true' : 'false');
      }
    }
    if (this.qualityBtn) {
      const shown = manual === 'auto' ? 'Auto' : manual;
      this.qualityBtn.innerHTML = `${shown} <i class="ri-arrow-down-s-line" aria-hidden="true"></i>`;
      this.qualityBtn.setAttribute('aria-label', `清晰度：${shown}`);
      this.qualityBtn.title = `清晰度：${shown}`;
    }
  },

  /**
   * User requested a tier: delegate to the controller (single decode path) and
   * surface the transition without blocking playback.
   */
  switchResolution(res) {
    const playback = this.playback;
    if (!playback) return false;
    const value = res == null ? 'auto' : String(res);
    const ok = playback.setQuality(value);
    if (!ok) {
      this.showSwitchToast('该清晰度不可用');
      return false;
    }
    if (value === 'auto') this.showSwitchToast('自动清晰度');
    else this.showSwitchToast(`清晰度：${value}`);
    return true;
  },

  /** Lightweight toast over the video (quality changes, seeks, speed). */
  showSwitchToast(message, duration = 1800) {
    if (!message) return;
    let element = this.container.querySelector('.vc-switch-toast');
    if (!element) {
      element = document.createElement('div');
      element.className = 'vc-switch-toast';
      element.setAttribute('role', 'status');
      element.setAttribute('aria-live', 'polite');
      this.container.appendChild(element);
    }
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => element.classList.remove('show'), duration);
  },
};
