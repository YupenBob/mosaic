/**
 * Music Player — Global singleton player with mini-player bar.
 *
 * Features:
 *   - Play/pause, prev/next, volume, seek
 *   - Playlist queue management
 *   - 3 loop modes (repeat one, repeat all, shuffle)
 *   - Waveform visualization
 *   - Media Session API (lock screen controls)
 *   - localStorage position + volume memory
 *   - Background playback across page navigation
 */

import { $, $$ } from './utils.js';

const STORAGE_KEY = 'mosaic_music';

// Global state (survives page navigations when script doesn't reload)
let playerState = {
  queue: [], // Array of track objects
  currentIndex: -1,
  isPlaying: false,
  loopMode: 'all', // 'one' | 'all' | 'shuffle'
  volume: 1,
  currentTime: 0,
  duration: 0,
};

let audioElement = null;
let _waveformInstance = null;

/** Load persisted state */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      playerState.volume = saved.volume ?? 1;
      playerState.loopMode = saved.loopMode || 'all';
      playerState.currentIndex = saved.currentIndex ?? -1;
      playerState.queue = saved.queue || [];
      playerState.currentTime = saved.currentTime || 0;
    }
  } catch {
    /* ignore */
  }
}

/** Save state */
function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        volume: playerState.volume,
        loopMode: playerState.loopMode,
        currentIndex: playerState.currentIndex,
        queue: playerState.queue.map((t) => ({
          file: t.file,
          title: t.title,
          artist: t.artist,
          cover: t.cover,
          sources: t.sources,
          duration: t.duration,
          waveform: t.waveform,
        })),
        currentTime: audioElement ? audioElement.currentTime : playerState.currentTime,
      }),
    );
  } catch {
    /* ignore */
  }
}

/** Initialize audio element (singleton) */
function getAudio() {
  if (!audioElement) {
    audioElement = new Audio();
    audioElement.preload = 'auto';
    audioElement.volume = playerState.volume;

    audioElement.addEventListener('timeupdate', () => {
      playerState.currentTime = audioElement.currentTime;
      updateProgressUI();
    });

    audioElement.addEventListener('loadedmetadata', () => {
      playerState.duration = audioElement.duration;
      updateDurationUI();
    });

    audioElement.addEventListener('ended', () => {
      handleTrackEnd();
    });

    audioElement.addEventListener('play', () => {
      playerState.isPlaying = true;
      updatePlayUI();
      setupMediaSession();
    });

    audioElement.addEventListener('pause', () => {
      playerState.isPlaying = false;
      updatePlayUI();
    });

    audioElement.addEventListener('error', () => {
      playerState.isPlaying = false;
      updatePlayUI();
    });
  }
  return audioElement;
}

/** Load and play a track by queue index */
function loadTrack(index) {
  const audio = getAudio();
  const track = playerState.queue[index];
  if (!track) return;

  playerState.currentIndex = index;

  // Pick best source
  const src = track.sources['320k'] || track.sources['128k'] || Object.values(track.sources)[0];
  if (!src) return;

  audio.src = src;
  audio.load();
  audio.play().catch(() => {});
  saveState();
}

/** Handle track end */
function handleTrackEnd() {
  switch (playerState.loopMode) {
    case 'one':
      loadTrack(playerState.currentIndex);
      break;
    case 'shuffle': {
      const next = Math.floor(Math.random() * playerState.queue.length);
      loadTrack(next);
      break;
    }
    case 'all':
    default: {
      const next = (playerState.currentIndex + 1) % playerState.queue.length;
      if (next === 0 && playerState.queue.length > 1) {
        // Reached end of playlist
        loadTrack(next);
      } else {
        loadTrack(next);
      }
      break;
    }
  }
}

/** Toggle play */
function togglePlay() {
  const audio = getAudio();
  if (!audio.src && playerState.queue.length > 0) {
    loadTrack(playerState.currentIndex >= 0 ? playerState.currentIndex : 0);
    return;
  }
  if (audio.paused) {
    audio.play().catch(() => {});
  } else {
    audio.pause();
  }
}

/** Play specific track (or add and play) */
function playTrack(track, trackList) {
  // If this track list is different from current queue, replace
  const isNewQueue = !playerState.queue.length || playerState.queue[0]?.file !== trackList?.[0]?.file;

  if (isNewQueue && trackList) {
    playerState.queue = [...trackList];
  }

  const idx = playerState.queue.findIndex((t) => t.file === track.file);
  if (idx >= 0) {
    loadTrack(idx);
  } else {
    playerState.queue.push(track);
    loadTrack(playerState.queue.length - 1);
  }

  saveState();
}

/** Previous track */
function prevTrack() {
  const audio = getAudio();
  // If more than 3 seconds in, restart current; otherwise go to previous
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  let prev = playerState.currentIndex - 1;
  if (prev < 0) prev = playerState.queue.length - 1;
  loadTrack(prev);
}

/** Next track */
function nextTrack() {
  let next;
  if (playerState.loopMode === 'shuffle') {
    next = Math.floor(Math.random() * playerState.queue.length);
  } else {
    next = (playerState.currentIndex + 1) % playerState.queue.length;
  }
  loadTrack(next);
}

/** Cycle loop mode */
function cycleLoopMode() {
  const modes = ['all', 'one', 'shuffle'];
  const idx = modes.indexOf(playerState.loopMode);
  playerState.loopMode = modes[(idx + 1) % modes.length];
  saveState();
  updateLoopUI();
}

/** Seek to position */
function seekTo(pct) {
  const audio = getAudio();
  if (audio.duration) {
    audio.currentTime = pct * audio.duration;
  }
}

/** ── UI Updates ── */
function updatePlayUI() {
  const btns = $$('[data-music-action="play"]');
  btns.forEach((btn) => {
    btn.innerHTML = playerState.isPlaying ? '<i class="ri-pause-fill"></i>' : '<i class="ri-play-fill"></i>';
  });
}

function updateProgressUI() {
  const audio = getAudio();
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;

  $$('.music-mini-progress-fill').forEach((el) => {
    el.style.width = pct + '%';
  });
  $$('.music-track').forEach((el) => {
    el.classList.toggle('playing', el.dataset.index === String(playerState.currentIndex));
  });

  if (_waveformInstance && typeof _waveformInstance.setProgress === 'function') {
    _waveformInstance.setProgress(audio.currentTime / audio.duration);
  }
}

function updateDurationUI() {
  const miniDuration = $('.music-mini-duration');
  if (miniDuration && playerState.duration) {
    miniDuration.textContent = fmtTime(playerState.duration);
  }
}

function updateLoopUI() {
  const btn = $('[data-music-action="loop"]');
  if (btn) {
    const icons = { all: 'ri-repeat-line', one: 'ri-repeat-one-line', shuffle: 'ri-shuffle-line' };
    btn.innerHTML = `<i class="${icons[playerState.loopMode] || icons.all}"></i>`;
  }
}

/** ── Media Session API ── */
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const track = playerState.queue[playerState.currentIndex];
  if (!track) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title || 'Unknown',
    artist: track.artist || 'Unknown',
    album: track.album || '',
    artwork: track.cover ? [{ src: track.cover, sizes: '512x512', type: 'image/webp' }] : [],
  });

  navigator.mediaSession.setActionHandler('play', () => togglePlay());
  navigator.mediaSession.setActionHandler('pause', () => getAudio().pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
  navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) getAudio().currentTime = details.seekTime;
  });
}

/** Format seconds to mm:ss or h:mm:ss */
function fmtTime(sec) {
  if (!isFinite(sec) || sec <= 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}

/** ── Mini Player ── */
function getMiniPlayer() {
  let el = $('#music-mini-player');
  if (!el) {
    el = document.createElement('div');
    el.id = 'music-mini-player';
    el.className = 'music-mini-player';
    el.innerHTML = `
      <div class="music-mini-progress"><div class="music-mini-progress-fill"></div></div>
      <div class="music-mini-cover"><img src="" alt="" /></div>
      <div class="music-mini-info">
        <span class="music-mini-title"></span>
        <span class="music-mini-artist"></span>
      </div>
      <span class="music-mini-duration" style="font-size:11px;font-family:var(--font-mono);color:var(--color-text-tertiary)"></span>
      <div class="music-mini-controls">
        <button class="music-mini-btn" data-music-action="loop" title="Loop mode"><i class="ri-repeat-line"></i></button>
        <button class="music-mini-btn" data-music-action="prev"><i class="ri-skip-back-fill"></i></button>
        <button class="music-mini-btn play-btn" data-music-action="play"><i class="ri-play-fill"></i></button>
        <button class="music-mini-btn" data-music-action="next"><i class="ri-skip-forward-fill"></i></button>
        <button class="music-mini-btn music-mini-close" data-music-action="close"><i class="ri-close-line"></i></button>
      </div>
    `;
    document.body.appendChild(el);

    // Bind events
    el.querySelector('[data-music-action="play"]').addEventListener('click', togglePlay);
    el.querySelector('[data-music-action="prev"]').addEventListener('click', prevTrack);
    el.querySelector('[data-music-action="next"]').addEventListener('click', nextTrack);
    el.querySelector('[data-music-action="loop"]').addEventListener('click', cycleLoopMode);
    el.querySelector('[data-music-action="close"]').addEventListener('click', () => {
      const audio = getAudio();
      audio.pause();
      audio.src = '';
      playerState.isPlaying = false;
      playerState.queue = [];
      playerState.currentIndex = -1;
      updatePlayUI();
      updateMiniPlayerUI();
      el.classList.remove('active');
      saveState();
    });

    // Click on progress area to seek
    el.querySelector('.music-mini-progress').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      seekTo(pct);
    });
  }
  return el;
}

function updateMiniPlayerUI() {
  const el = getMiniPlayer();
  const track = playerState.queue[playerState.currentIndex];

  if (track && (playerState.isPlaying || audioElement?.src)) {
    el.classList.add('active');
    el.querySelector('.music-mini-title').textContent = track.title || '';
    el.querySelector('.music-mini-artist').textContent = track.artist || '';
    if (track.cover) {
      el.querySelector('.music-mini-cover img').src = track.cover;
    }
  } else if (!playerState.isPlaying && !audioElement?.src) {
    el.classList.remove('active');
  }
}

/** ── Initialization ── */
export function initMusicPlayer() {
  loadState();
  getAudio();
  getMiniPlayer();

  // Restore playback if there was an active track
  if (playerState.queue.length > 0 && playerState.currentIndex >= 0) {
    const track = playerState.queue[playerState.currentIndex];
    const src = track.sources?.['320k'] || track.sources?.['128k'] || Object.values(track.sources || {})[0];
    if (src) {
      const audio = getAudio();
      audio.src = src;
      if (playerState.currentTime > 0) {
        audio.currentTime = playerState.currentTime;
      }
      updateMiniPlayerUI();
      updatePlayUI();
      updateLoopUI();
    }
  }

  // Wire up in-post track list items
  $$('.music-track').forEach((el) => {
    el.addEventListener('click', () => {
      const index = parseInt(el.dataset.index);
      const tracks = window.__MUSIC_TRACKS || [];
      if (tracks[index]) {
        playTrack(tracks[index], tracks);
        updateMiniPlayerUI();
        updatePlayUI();
        saveState();
      }
    });
  });
}

// Expose for EJS templates to inject track data
window.__MUSIC_TRACKS = [];
