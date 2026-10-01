/** Quality UI uses the published source tiers. */
export const SPEEDS = window.__MOSAIC_CONFIG?.player?.speeds || [0.5, 0.75, 1, 1.25, 1.5, 2];
export const RES_ORDER = window.__MOSAIC_CONFIG?.player?.qualityOrder || [
  '4K',
  '1080p',
  '720p',
  '480p',
  '360p',
  '240p',
];
export const qualityControls = {
  buildQualityMenu() {
    if (!this.qualityMenu) return;
    this.qualityMenu.innerHTML = '';
    // Auto option for HLS
    if (this.hls) {
      const abtn = document.createElement('button');
      abtn.textContent = 'Auto';
      abtn.dataset.res = 'auto';
      abtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.switchResolution('auto');
        this.qualityMenu.classList.remove('open');
      });
      this.qualityMenu.appendChild(abtn);
    }
    Object.keys(this.sources).forEach((res) => {
      if (res === 'single') return;
      const btn = document.createElement('button');
      btn.textContent = res;
      btn.dataset.res = res;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.switchResolution(res);
        this.qualityMenu.classList.remove('open');
      });
      this.qualityMenu.appendChild(btn);
    });
    this.updateQualityActive();
  },
  updateQualityActive() {
    if (!this.qualityMenu) return;
    this.qualityMenu.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.res === this.currentRes);
    });
    if (this.qualityBtn) {
      var label = this.currentRes === 'auto' || !this.currentRes ? 'Auto' : this.currentRes;
      this.qualityBtn.innerHTML = label + ' <i class="ri-arrow-down-s-line"></i>';
    }
  },
};
