/**
 * Photo Gallery - Grid + Fullscreen with filmstrip + quality selector.
 * macOS-style toolbar at top, thumbnail strip at bottom.
 */
import { $, $$ } from './utils.js';

const RESOLUTIONS = ['480p', '720p', '1080p', 'orig'];
const RES_LABELS = { '480p': '低清', '720p': '中清', '1080p': '高清', 'orig': '原图' };
const PRELOAD_RANGE = { 3: { '480p': 10, '720p': 3, '1080p': 1, 'orig': 0 } };

let state = {
  photos: [],
  currentIndex: 0,
  currentRes: '1080p',
  isOpen: false,
};
let _updateTimer = null;

export function initGallery() {
  const items = $$('.gallery-item img, .gallery-single-item img');
  state.photos = items.map((img, i) => ({
    src480: img.dataset.src480 || img.src,
    src720: img.dataset.src720 || img.src,
    src1080: img.dataset.src1080 || img.src,
    srcOrig: img.dataset.srcOrig || img.src,
    index: i,
  }));

  if (state.photos.length === 0) return;

  // Detect preferred quality
  state.currentRes = detectResolution();

  setupLazyLoading();
  items.forEach((img, i) => img.addEventListener('click', () => open(i)));
  createOverlay();
  document.addEventListener('keydown', handleKeyboard);
}

function detectResolution() {
  const w = window.innerWidth * (window.devicePixelRatio || 1);
  if (w >= 1920) return '1080p';
  if (w >= 1280) return '720p';
  return '480p';
}

function getSrc(photo, res) {
  if (res === 'orig') return photo.srcOrig || photo.src1080 || photo.src720 || photo.src480;
  const key = 'src' + res.replace('p', '');
  return photo[key] || photo.src1080 || photo.src720 || photo.src480;
}

/* ========== Lazy Loading Grid ========== */
function setupLazyLoading() {
  if (!('IntersectionObserver' in window)) {
    $$('.gallery-item img, .gallery-single-item img').forEach(loadThumb);
    return;
  }
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { loadThumb(e.target); obs.unobserve(e.target); } });
  }, { rootMargin: '200px' });
  $$('.gallery-item img, .gallery-single-item img').forEach((img) => obs.observe(img));
}

function loadThumb(img) {
  const src = img.dataset.src480 || img.src;
  if (!src || img.classList.contains('loaded')) return;
  img.src = src;
  img.onload = () => img.classList.add('loaded');
  if (img.complete) img.classList.add('loaded');
}

/* ========== Overlay ========== */
function createOverlay() {
  const ov = document.createElement('div');
  ov.className = 'gallery-overlay';
  ov.id = 'gallery-overlay';
  ov.innerHTML = `
    <div class="gallery-toolbar">
      <button class="gallery-done-btn" id="gallery-done"><i class="ri-close-line"></i> Done</button>
      <span class="gallery-counter" id="gallery-counter">1 / ${state.photos.length}</span>
      <div class="gallery-quality-pills" id="gallery-quality">
        ${RESOLUTIONS.map((r) => `<button class="gq-pill" data-res="${r}">${RES_LABELS[r]}</button>`).join('')}
      </div>
      <a class="gallery-dl-btn" id="gallery-download" href="#" download title="Download"><i class="ri-download-line"></i></a>
    </div>
    <div class="gallery-main-area">
      <button class="gallery-nav-btn gallery-nav-prev" id="gallery-prev"><i class="ri-arrow-left-s-line"></i></button>
      <img class="gallery-current-image" id="gallery-current-img" alt="" />
      <button class="gallery-nav-btn gallery-nav-next" id="gallery-next"><i class="ri-arrow-right-s-line"></i></button>
    </div>
    <div class="gallery-filmstrip" id="gallery-filmstrip">
      <button class="filmstrip-scroll filmstrip-scroll-left" id="filmstrip-left"><i class="ri-arrow-left-s-line"></i></button>
      <div class="filmstrip-track" id="filmstrip-track"></div>
      <button class="filmstrip-scroll filmstrip-scroll-right" id="filmstrip-right"><i class="ri-arrow-right-s-line"></i></button>
    </div>
  `;
  document.body.appendChild(ov);

  $('#gallery-done').addEventListener('click', close);
  $('#gallery-prev').addEventListener('click', () => nav(-1));
  $('#gallery-next').addEventListener('click', () => nav(1));
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });

  // Quality pills
  $$('.gq-pill').forEach((pill) => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      switchQuality(pill.dataset.res);
    });
  });

  // Filmstrip scroll buttons
  $('#filmstrip-left').addEventListener('click', () => scrollFilmstrip(-200));
  $('#filmstrip-right').addEventListener('click', () => scrollFilmstrip(200));

  setupGestures(ov);
}

/* ========== Open / Close ========== */
function open(index) {
  state.currentIndex = index;
  state.isOpen = true;
  const ov = $('#gallery-overlay');
  if (!ov) return;
  ov.classList.add('open');
  document.body.style.overflow = 'hidden';
  updateImage();
  updateQualityPills();
  renderFilmstrip();
}

function close() {
  state.isOpen = false;
  const ov = $('#gallery-overlay');
  if (ov) ov.classList.remove('open');
  document.body.style.overflow = '';
}

/* ========== Navigation ========== */
function nav(dir) {
  const N = state.photos.length;
  state.currentIndex = (state.currentIndex + dir + N) % N;
  updateImage();
  scrollFilmstripToCurrent();
}

function updateImage() {
  resetZoom();
  const img = $('#gallery-current-img');
  const counter = $('#gallery-counter');
  const photo = state.photos[state.currentIndex];
  if (!photo) return;
  img.style.opacity = '0';
  clearTimeout(_updateTimer);
  _updateTimer = setTimeout(() => {
    const url = getSrc(photo, state.currentRes);
    img.src = url;
    if (counter) counter.textContent = `${state.currentIndex + 1} / ${state.photos.length}`;
    img.style.opacity = '1';
    const dl = $('#gallery-download');
    if (dl) dl.href = url;
    preloadNeighbors(state.currentIndex);
    highlightFilmstripThumb();
  }, 120);
}

/* ========== Quality Switching ========== */
function switchQuality(res) {
  if (res === state.currentRes) return;
  state.currentRes = res;
  updateQualityPills();
  // Brief label flash
  showQualityFlash(RES_LABELS[res] || res);
  updateImage();
}

function showQualityFlash(label) {
  let el = document.getElementById('gallery-quality-flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gallery-quality-flash';
    el.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:9999;background:rgba(0,0,0,0.75);color:#fff;padding:6px 16px;border-radius:20px;font-size:14px;pointer-events:none;opacity:0;transition:opacity 0.15s ease';
    document.body.appendChild(el);
  }
  el.textContent = label;
  el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.opacity = '0'; }, 800);
}

function updateQualityPills() {
  $$('.gq-pill').forEach((p) => p.classList.toggle('active', p.dataset.res === state.currentRes));
}

/* ========== Preloading ========== */
function preloadNeighbors(idx) {
  const N = state.photos.length;
  const range = PRELOAD_RANGE[3][state.currentRes] || 3;
  for (let i = -range; i <= range; i++) {
    if (i === 0) continue;
    const ni = (idx + i + N) % N;
    if (!state.photos[ni]._preloaded) {
      const pre = new Image();
      pre.src = getSrc(state.photos[ni], i === 0 ? state.currentRes : '720p');
      state.photos[ni]._preloaded = true;
    }
  }
}

/* ========== Filmstrip ========== */
let filmstripRendered = false;

function renderFilmstrip() {
  const N = state.photos.length;
  const track = $('#filmstrip-track');
  if (!track) return;

  // For 1000+ photos, render in batches
  const initialCount = N > 1000 ? 200 : N;
  track.innerHTML = '';

  for (let i = 0; i < initialCount; i++) {
    track.appendChild(createThumb(i));
  }

  // Lazy-load remaining thumbnails
  if (N > initialCount) {
    if (!('IntersectionObserver' in window)) {
      for (let i = initialCount; i < N; i++) track.appendChild(createThumb(i));
    } else {
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        const currentCount = track.children.length;
        const batchEnd = Math.min(currentCount + 100, N);
        for (let i = currentCount; i < batchEnd; i++) {
          track.appendChild(createThumb(i));
        }
        if (batchEnd >= N) obs.disconnect();
      }
    });
    const sentinel = document.createElement('div');
    sentinel.style.width = '1px';
    track.appendChild(sentinel);
    obs.observe(sentinel);
    } // end IntersectionObserver else
  }

  filmstripRendered = true;
  // Scroll to current
  requestAnimationFrame(() => scrollFilmstripToCurrent());
}

function createThumb(i) {
  const photo = state.photos[i];
  const div = document.createElement('div');
  div.className = 'filmstrip-thumb';
  div.dataset.index = i;
  const img = document.createElement('img');
  img.src = getSrc(photo, '480p');
  img.alt = '' + (i + 1);
  img.loading = 'lazy';
  div.appendChild(img);
  div.addEventListener('click', () => {
    state.currentIndex = i;
    updateImage();
    scrollFilmstripToCurrent();
  });
  return div;
}

function highlightFilmstripThumb() {
  $$('.filmstrip-thumb').forEach((t, i) => {
    t.classList.toggle('active', i === state.currentIndex);
  });
}

function scrollFilmstripToCurrent() {
  const track = $('#filmstrip-track');
  const thumb = track?.children[state.currentIndex];
  if (thumb) {
    thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
  highlightFilmstripThumb();
}

function scrollFilmstrip(delta) {
  const track = $('#filmstrip-track');
  if (track) track.scrollBy({ left: delta, behavior: 'smooth' });
}

/* ========== Keyboard ========== */
function handleKeyboard(e) {
  if (!state.isOpen) return;
  switch (e.key) {
    case 'ArrowLeft':  nav(-1); break;
    case 'ArrowRight': nav(1); break;
    case 'Home': state.currentIndex = 0; updateImage(); scrollFilmstripToCurrent(); break;
    case 'End':  state.currentIndex = state.photos.length - 1; updateImage(); scrollFilmstripToCurrent(); break;
    case 'PageUp':   nav(-10); break;
    case 'PageDown': nav(10); break;
    case 'Escape': close(); break;
    case '1': switchQuality('480p'); break;
    case '2': switchQuality('720p'); break;
    case '3': switchQuality('1080p'); break;
    case '4': switchQuality('orig'); break;
  }
}

/* ========== Gestures (swipe + pinch + scroll zoom) ========== */
let zoomState = { scale: 1, panX: 0, panY: 0, lastTap: 0 };

function resetZoom() {
  zoomState = { scale: 1, panX: 0, panY: 0, lastTap: 0 };
  const img = $('#gallery-current-img');
  if (img) img.style.transform = '';
}

function applyTransform() {
  const img = $('#gallery-current-img');
  if (!img) return;
  // translate BEFORE scale: pan values are in screen pixels, scale doesn't amplify them
  const t = `translate(${zoomState.panX}px, ${zoomState.panY}px) scale(${zoomState.scale})`;
  img.style.transform = t;
  img.style.cursor = zoomState.scale > 1 ? 'grab' : '';
}

function setupGestures(overlay) {
  // --- Touch (swipe + pinch) ---
  let touchState = { sx: 0, sy: 0, cx: 0, cy: 0, active: false, startDist: 0, startScale: 1, fingers: 0 };
  overlay.addEventListener('touchstart', (e) => {
    touchState.fingers = e.touches.length;
    if (e.touches.length === 1) {
      touchState.sx = e.touches[0].clientX; touchState.sy = e.touches[0].clientY;
      touchState.cx = touchState.sx; touchState.cy = touchState.sy;
      touchState.active = true;
    } else if (e.touches.length === 2) {
      touchState.startDist = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);
      touchState.startScale = zoomState.scale;
      touchState.active = false; // Cancel swipe when pinch starts
    }
  }, { passive: true });

  overlay.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && touchState.active && zoomState.scale === 1) {
      touchState.cx = e.touches[0].clientX; touchState.cy = e.touches[0].clientY;
      const img = $('#gallery-current-img');
      if (img) img.style.transform = zoomState.scale > 1 ? '' : `translateX(${touchState.cx - touchState.sx}px)`;
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(e.touches[1].clientX - e.touches[0].clientX, e.touches[1].clientY - e.touches[0].clientY);
      // Pinch center point — zoom toward it
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const img = $('#gallery-current-img');
      if (!img) return;
      const imgRect = img.getBoundingClientRect();
      const cx = midX - (imgRect.left + imgRect.width / 2), cy = midY - (imgRect.top + imgRect.height / 2);
      if (touchState.startDist > 0) {
        const oldScale = zoomState.scale;
        const newScale = Math.max(0.5, Math.min(5, touchState.startScale * (dist / touchState.startDist)));
        zoomState.panX = cx - (cx - zoomState.panX) * (newScale / oldScale);
        zoomState.panY = cy - (cy - zoomState.panY) * (newScale / oldScale);
        zoomState.scale = newScale;
        applyTransform();
      }
    }
  }, { passive: true });

  overlay.addEventListener('touchend', () => {
    if (touchState.active && zoomState.scale <= 1) {
      touchState.active = false;
      const dx = touchState.cx - touchState.sx;
      if (Math.abs(dx) > 80) nav(dx > 0 ? -1 : 1);
    }
    touchState.fingers = 0;
  });

  // --- Mouse wheel zoom (centered on cursor) ---
  overlay.addEventListener('wheel', (e) => {
    e.preventDefault();
    const img = $('#gallery-current-img');
    if (!img) return;
    const imgRect = img.getBoundingClientRect();
    const cx = e.clientX - (imgRect.left + imgRect.width / 2);
    const cy = e.clientY - (imgRect.top + imgRect.height / 2);
    const oldScale = zoomState.scale;
    const newScale = Math.max(0.5, Math.min(5, oldScale + (e.deltaY > 0 ? -0.15 : 0.15)));
    const ratio = newScale / oldScale;
    zoomState.panX = cx - (cx - zoomState.panX) * ratio;
    zoomState.panY = cy - (cy - zoomState.panY) * ratio;
    zoomState.scale = newScale;
    applyTransform();
  }, { passive: false });

  // --- Free drag when zoomed ---
  let dragStart = null;
  const img = $('#gallery-current-img');
  if (img) {
    img.addEventListener('mousedown', (e) => {
      if (zoomState.scale <= 1) return;
      e.preventDefault();
      dragStart = { x: e.clientX - zoomState.panX, y: e.clientY - zoomState.panY };
      img.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragStart) return;
      zoomState.panX = e.clientX - dragStart.x;
      zoomState.panY = e.clientY - dragStart.y;
      applyTransform();
    });
    document.addEventListener('mouseup', () => {
      if (dragStart) { dragStart = null; img.style.cursor = 'grab'; }
    });
  }

  // --- Double tap zoom (centered on tap point) ---
  overlay.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (zoomState.scale > 1.2) { resetZoom(); applyTransform(); return; }
    const img = $('#gallery-current-img');
    if (!img) return;
    const imgRect = img.getBoundingClientRect();
    const cx = e.clientX - (imgRect.left + imgRect.width / 2), cy = e.clientY - (imgRect.top + imgRect.height / 2);
    const oldScale = zoomState.scale;
    const newScale = 2;
    zoomState.panX = cx - (cx - zoomState.panX) * (newScale / oldScale);
    zoomState.panY = cy - (cy - zoomState.panY) * (newScale / oldScale);
    zoomState.scale = newScale;
    applyTransform();
  });
}
