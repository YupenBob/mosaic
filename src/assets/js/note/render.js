/**
 * Markup for the Xiaohongshu-style note modal. Pure render functions: no state,
 * no listeners — `index.js` owns behaviour and delegates events on the rendered
 * panel. `note.blocks[].html` is trusted SSG output (marked, see
 * scripts/blocks.mjs); every other field is escaped before interpolation.
 */
import { t } from './strings.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** @param {number} seconds */
function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Compact display count (1.2k / 3.4w) shared with the like button updater.
 * @param {number} value
 * @returns {string}
 */
export function formatCount(value) {
  return fmtCount(value);
}

/** @param {number} value */
function fmtCount(value) {
  const n = Number(value) || 0;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Ordered media shown in the cover carousel: photos first, then video posters,
 * then the post cover, finally a music track cover as a soft hero. An empty
 * result switches the modal to its single-column article layout.
 * @param {object} note
 * @returns {Array<{kind: 'photo'|'video'|'cover', item: object}>}
 */
export function collectMedia(note) {
  const photos = (note.photos || []).filter((photo) => !photo.pending);
  if (photos.length) return photos.map((photo) => ({ kind: 'photo', item: photo }));
  const videos = (note.videos || []).filter((video) => !video.pending && video.poster);
  if (videos.length) return videos.map((video) => ({ kind: 'video', item: video }));
  if (note.cover) return [{ kind: 'cover', item: { poster: note.cover, aspect: note.coverAspect } }];
  const musicCover = (note.music || []).map((track) => track.cover).find(Boolean);
  if (musicCover) return [{ kind: 'cover', item: { poster: musicCover } }];
  return [];
}

/**
 * One carousel slide. Every slide fills the media pane edge-to-edge
 * (`object-fit: cover`) so the overlay keeps the Xiaohongshu feel instead of
 * letterboxing; the LQIP placeholder sits behind the image while it decodes.
 * @param {{kind: string, item: object}} media
 * @param {number} index
 * @param {string} title
 */
function mediaSlide(media, index, title) {
  const alt = `${title} · ${t('photoAlt')} ${index + 1}`;
  const item = media.item;
  if (media.kind === 'video') {
    return `<figure class="note-media-item is-video" data-media-index="${index}">
      <div class="note-media-frame" style="background-image:url('${escapeHtml(item.poster || '')}')">
        <img class="note-media-img" src="${escapeHtml(item.poster || '')}" alt="${escapeHtml(title)}" loading="lazy" decoding="async" />
        <button type="button" class="note-media-play" data-video-index="${index}" aria-label="${escapeHtml(t('playVideo'))}">
          <i class="ri-play-fill" aria-hidden="true"></i>
        </button>
      </div>
    </figure>`;
  }
  const src = item.src480 || item.poster || '';
  const srcset = item.src480
    ? ` srcset="${escapeHtml(item.src480)} 480w, ${escapeHtml(item.src720 || item.src480)} 720w, ${escapeHtml(
        item.src1080 || item.src720 || item.src480,
      )} 1080w" sizes="(max-width: 900px) 100vw, 56vw"`
    : '';
  const backdrop = item.src10p || item.poster;
  const lqip = backdrop ? ` style="background-image:url('${escapeHtml(backdrop)}')"` : '';
  return `<figure class="note-media-item" data-media-index="${index}">
    <div class="note-media-frame note-media-lqip"${lqip}>
      <img class="note-media-img"${srcset} src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" />
    </div>
  </figure>`;
}

/**
 * Media carousel + counter/dots (hidden when there is a single item).
 * @param {object} note
 * @returns {string}
 */
export function renderMedia(note) {
  const media = collectMedia(note);
  if (!media.length) return '';
  const slides = media.map((entry, index) => mediaSlide(entry, index, note.title)).join('');
  const multiple = media.length > 1;
  const dots = multiple
    ? `<div class="note-dots" aria-hidden="true">${media
        .map((_, index) => `<span class="note-dot${index === 0 ? ' active' : ''}" data-dot="${index}"></span>`)
        .join('')}</div>`
    : '';
  return `<div class="note-media" data-media-count="${media.length}">
    <div class="note-media-track" tabindex="0" role="group" aria-label="${escapeHtml(t('dialogLabel'))}">${slides}</div>
    ${
      multiple
        ? `<button type="button" class="note-media-nav prev" data-nav="-1" aria-label="${escapeHtml(t('prevPhoto'))}">
             <i class="ri-arrow-left-s-line" aria-hidden="true"></i></button>
           <button type="button" class="note-media-nav next" data-nav="1" aria-label="${escapeHtml(t('nextPhoto'))}">
             <i class="ri-arrow-right-s-line" aria-hidden="true"></i></button>`
        : ''
    }
    ${dots}
  </div>`;
}

/**
 * Simplified music block: track list, one shared <audio> is driven by index.js.
 * @param {Array<object>} tracks
 */
function renderMusic(tracks) {
  const rows = tracks
    .filter((track) => !track.pending)
    .map((track, index) => {
      const source = track.sources ? Object.values(track.sources)[0] : '';
      if (!source) return '';
      const artwork = track.cover
        ? `<img class="note-music-cover" src="${escapeHtml(track.cover)}" alt="" loading="lazy" />`
        : '<span class="note-music-cover note-music-cover-fallback"><i class="ri-music-2-line" aria-hidden="true"></i></span>';
      return `<li class="note-music-track" data-track-index="${index}">
        <button type="button" class="note-music-toggle" data-audio-src="${escapeHtml(source)}" data-audio-title="${escapeHtml(
          track.title || '',
        )}" aria-label="${escapeHtml(t('playVideo'))}"><i class="ri-play-fill" aria-hidden="true"></i></button>
        ${artwork}
        <span class="note-music-meta"><span class="note-music-title">${escapeHtml(track.title || '')}</span>
        <span class="note-music-artist">${escapeHtml(track.artist || '')}</span></span>
        <span class="note-music-duration">${fmtDuration(track.duration)}</span>
      </li>`;
    })
    .join('');
  if (!rows) return '';
  return `<section class="note-music"><h3 class="note-block-title">${escapeHtml(t('music'))}</h3><ul class="note-music-list">${rows}</ul></section>`;
}

/**
 * Inline video card (used for `videos`/`video` blocks that are not already in
 * the cover carousel). Uses native MP4 tiers only — HLS playback is owned by
 * playback-quality and the post page, so the modal never duplicates it.
 * @param {object} video
 * @param {string} slug
 */
function renderVideoCard(video, slug) {
  if (!video || video.pending) return '';
  const sources = Object.entries(video.sources || {})
    .sort(([a], [b]) => parseInt(b, 10) - parseInt(a, 10))
    .map(([tier, url]) => `<source data-res="${escapeHtml(tier)}" src="${escapeHtml(url)}" type="video/mp4" />`)
    .join('');
  const hasSources = !!sources;
  // MP4 tiers play inline (native element). HLS-only media opens the post page,
  // which owns the shared decode controller — the modal never duplicates HLS.
  const videoElement = hasSources
    ? `<video class="note-video-el" controls playsinline preload="none" poster="${escapeHtml(video.poster || '')}" hidden>${sources}</video>`
    : '';
  return `<div class="note-video-card">
    <button type="button" class="note-video-poster" data-expand-video="${escapeHtml(slug)}"${
      hasSources ? '' : ' data-open-post'
    } aria-label="${escapeHtml(hasSources ? t('playVideo') : t('openPostToPlay'))}">
      <img src="${escapeHtml(video.poster || '')}" alt="" loading="lazy" />
      <span class="note-video-badge"><i class="ri-play-fill" aria-hidden="true"></i></span>
    </button>
    ${videoElement}
  </div>`;
}

/**
 * Body blocks. Text is injected as trusted SSG HTML; gallery/photo blocks are
 * skipped because the carousel already shows them; video blocks render only when
 * the carousel is showing photos (otherwise the carousel shows the video).
 * @param {object} note
 * @returns {string}
 */
export function renderBlocks(note) {
  const blocks = note.blocks || [];
  const carouselShowsVideo = !(note.photos || []).some((photo) => !photo.pending);
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.html) parts.push(`<div class="note-rich">${block.html}</div>`);
    if (block.type === 'music') parts.push(renderMusic(block.tracks || []));
    if ((block.type === 'video' || block.type === 'videos') && !carouselShowsVideo) {
      const videos = block.type === 'video' ? [block.video] : block.videos || [];
      for (const video of videos) parts.push(renderVideoCard(video, note.slug));
    }
  }
  if (!parts.length && note.description)
    parts.push(`<p class="note-rich note-rich-fallback">${escapeHtml(note.description)}</p>`);
  return parts.join('');
}

/**
 * Header (category/title/description/tags/date) + stats + actions.
 * @param {object} note
 * @param {{liked: boolean}} state
 */
export function renderHeader(note, { liked }) {
  const stats = note.stats || {};
  const tags = (note.tags || []).map((tag) => `<span class="note-tag">#${escapeHtml(tag)}</span>`).join('');
  const date = note.date ? escapeHtml(String(note.date).slice(0, 10)) : '';
  return `<header class="note-header">
    <span class="note-category">${escapeHtml(note.category || '')}</span>
    <h2 class="note-title" id="note-modal-title">${escapeHtml(note.title)}</h2>
    ${note.description ? `<p class="note-desc">${escapeHtml(note.description)}</p>` : ''}
    <div class="note-tags">${tags}</div>
    <div class="note-meta">
      ${date ? `<span class="note-meta-item"><i class="ri-calendar-line" aria-hidden="true"></i>${date}</span>` : ''}
      <span class="note-meta-item note-stat-views"><i class="ri-eye-line" aria-hidden="true"></i>${fmtCount(stats.views)}</span>
      <span class="note-meta-item note-stat-dwell"><i class="ri-time-line" aria-hidden="true"></i>${fmtCount(
        stats.dwell_time,
      )}s</span>
    </div>
  </header>
  <footer class="note-footer">
    <div class="note-stats">
      <span class="note-like-count-wrap"><i class="ri-heart-line" aria-hidden="true"></i><span class="note-like-count">${fmtCount(
        stats.likes,
      )}</span></span>
    </div>
    <div class="note-actions">
      <button type="button" class="note-action note-like${liked ? ' liked' : ''}" data-note-like aria-pressed="${
        liked ? 'true' : 'false'
      }" aria-label="${escapeHtml(liked ? t('unlike') : t('like'))}">
        <i class="ri-heart-${liked ? 'fill' : 'line'}" aria-hidden="true"></i>
        <span>${escapeHtml(t('like'))}</span>
      </button>
      <button type="button" class="note-action note-share" data-note-share aria-label="${escapeHtml(
        t('shareTitle'),
      )}"><i class="ri-share-forward-line" aria-hidden="true"></i><span>${escapeHtml(t('shareTitle'))}</span></button>
    </div>
  </footer>`;
}

/**
 * Full modal content (media + body + header + footer). Notes without any visual
 * media get the single-column article layout (`.no-media`) instead of an empty
 * black media pane.
 * @param {object} note
 * @param {{liked: boolean}} state
 * @returns {string}
 */
export function renderNote(note, state = { liked: false }) {
  const hasMedia = collectMedia(note).length > 0;
  const media = hasMedia ? renderMedia(note) : '';
  const blocks = renderBlocks(note);
  const hasAside = !!blocks.trim();
  return `<div class="note-panel${hasAside ? ' has-aside' : ''}${hasMedia ? '' : ' no-media'}" data-note-panel>
    <button type="button" class="note-close" data-note-close aria-label="${escapeHtml(t('close'))}" data-autofocus>
      <i class="ri-close-line" aria-hidden="true"></i>
    </button>
    ${hasMedia ? `<div class="note-media-col">${media}</div>` : ''}
    <div class="note-body-col">
      <div class="note-scroll">
        ${renderHeader(note, state)}
        <div class="note-blocks">${blocks}</div>
      </div>
      <a class="note-open-post" href="${escapeHtml(note.permalink || '')}">${escapeHtml(t('openPost'))}<i class="ri-arrow-right-line" aria-hidden="true"></i></a>
    </div>
    <div class="note-toast" role="status" aria-live="polite" hidden></div>
  </div>`;
}

/** Loading placeholder shown while the note JSON is in flight. */
export function renderSkeleton() {
  return `<div class="note-panel note-panel-skeleton" data-note-panel aria-busy="true">
    <button type="button" class="note-close" data-note-close aria-label="${escapeHtml(t('close'))}" data-autofocus>
      <i class="ri-close-line" aria-hidden="true"></i>
    </button>
    <div class="note-skeleton-media"></div>
    <div class="note-skeleton-body">
      <span class="note-skeleton-line w40"></span>
      <span class="note-skeleton-line w80"></span>
      <span class="note-skeleton-line"></span>
      <span class="note-skeleton-line w60"></span>
      <span class="note-skeleton-status">${escapeHtml(t('loading'))}</span>
    </div>
  </div>`;
}
