/**
 * Upload flow — concurrent (2 at a time) presigned uploads with per-file
 * retry/cancel, thumbnails and graceful handling when the post isn't saved.
 */
import { upload, getToken } from '../src/api.js';
import { t } from './i18n.js';
import { escHtml } from './ui.js';

const CONCURRENCY = 3;
// Files above this size use resumable multipart uploads (R2 part uploads).
const MULTIPART_THRESHOLD = 100 * 1024 * 1024;
const MP_CONCURRENCY = 3;
const MP_PART_RETRIES = 3;
const MP_STATE_PREFIX = 'mosaic_mp_';

function mpStateKey(slug, filename) {
  return MP_STATE_PREFIX + slug + '/' + filename;
}

function mpSave(slug, filename, state) {
  try {
    localStorage.setItem(mpStateKey(slug, filename), JSON.stringify(state));
  } catch {}
}

function mpLoad(slug, filename, size) {
  try {
    const s = JSON.parse(localStorage.getItem(mpStateKey(slug, filename)) || 'null');
    if (s && s.uploadId && s.size === size && s.partSize && s.partCount) return s;
  } catch {}
  return null;
}

function mpClear(slug, filename) {
  try {
    localStorage.removeItem(mpStateKey(slug, filename));
  } catch {}
}

function currentSlug() {
  return document.getElementById('fm-slug')?.value || '';
}

function fileKind(name) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'mkv', 'webm', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'].includes(ext)) return 'audio';
  return 'file';
}

function fileIcon(kind) {
  return kind === 'image'
    ? 'ri-image-line'
    : kind === 'video'
      ? 'ri-video-line'
      : kind === 'audio'
        ? 'ri-music-line'
        : 'ri-file-line';
}

function fileSize(size) {
  return size > 1048576 ? (size / 1048576).toFixed(1) + ' MB' : (size / 1024).toFixed(0) + ' KB';
}

export function handleUploadFiles(files) {
  const slug = currentSlug();
  const progressEl = document.getElementById('upload-progress');
  if (!progressEl) return;

  // Not saved yet — inline hint instead of a native alert
  if (!slug) {
    progressEl.innerHTML = `
      <div class="draft-banner" style="background:var(--color-warning-soft);color:var(--color-warning)">
        <i class="ri-information-line"></i>
        <span>${t('editor.needSlugMsg')}</span>
        <span class="draft-actions"><button class="btn btn-secondary btn-sm" onclick="document.getElementById('fm-slug').focus()"><i class="ri-save-line"></i> ${t('editor.saveFirst')}</button></span>
      </div>`;
    return;
  }

  const token = getToken();
  const queue = [...files].map((file) => {
    const item = {
      file,
      kind: fileKind(file.name),
      slug,
      token,
      status: 'pending', // pending | uploading | done | error | cancelled
      controller: null,
      el: null,
      done: false,
    };
    item.el = renderItem(item);
    progressEl.appendChild(item.el);
    return item;
  });

  let index = 0;
  const runners = [];
  for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
    runners.push(work());
  }
  Promise.all(runners).then(() => {
    const doneCount = queue.filter((q) => q.status === 'done').length;
    if (doneCount > 0) {
      window.checkDirty && window.checkDirty();
      window.loadExistingMedia && window.loadExistingMedia(slug);
    }
  });

  async function work() {
    while (index < queue.length) {
      const item = queue[index++];
      if (item.status === 'cancelled') continue;
      await runItem(item);
    }
  }

  async function runItem(item) {
    if (item.status === 'done') return;
    item.status = 'uploading';
    setState(item, 'uploading', '0%');
    try {
      const ok = await uploadFilePresigned(item);
      if (!ok && item.status !== 'cancelled') await uploadFileDirect(item);
      if (item.status === 'cancelled') return;
      item.status = 'done';
      item.done = true;
      item.el.classList.add('upload-done');
      setState(item, 'done', t('editor.done'));
    } catch (err) {
      if (item.status === 'cancelled') return;
      item.status = 'error';
      item.el.classList.add('upload-error');
      setState(item, 'error', err.message || 'Error');
    }
  }
}

function renderItem(item) {
  const el = document.createElement('div');
  el.className = 'upload-item';
  let thumb = '';
  if (item.kind === 'image') {
    try {
      thumb = `<img src="${URL.createObjectURL(item.file)}" alt="" />`;
    } catch {}
  }
  el.innerHTML = `
    <div class="upload-item-icon">${thumb || `<i class="${fileIcon(item.kind)}"></i>`}</div>
    <div class="upload-item-info">
      <div class="upload-item-name">${escHtml(item.file.name)}</div>
      <div class="upload-item-meta"><span>${fileSize(item.file.size)}</span></div>
      <div class="upload-item-bar"><div class="upload-item-fill" style="width:0%"></div></div>
    </div>
    <div class="upload-item-status">0%</div>
    <div class="upload-item-actions">
      <button class="icon-btn" title="${t('editor.retry')}" aria-label="${t('editor.retry')}" style="display:none"><i class="ri-refresh-line"></i></button>
      <button class="icon-btn" title="${t('editor.cancelUpload')}" aria-label="${t('editor.cancelUpload')}"><i class="ri-close-line"></i></button>
    </div>
  `;
  item.el = el;
  el.querySelector('.upload-item-actions .icon-btn:last-child').onclick = () => cancelItem(item);
  el.querySelector('.upload-item-actions .icon-btn:first-child').onclick = () => retryItem(item);
  return el;
}

function setState(item, status, text) {
  const fill = item.el.querySelector('.upload-item-fill');
  const statusEl = item.el.querySelector('.upload-item-status');
  const metaEl = item.el.querySelector('.upload-item-meta');
  const retryBtn = item.el.querySelector('.upload-item-actions .icon-btn:first-child');
  const cancelBtn = item.el.querySelector('.upload-item-actions .icon-btn:last-child');
  if (fill) fill.style.width = status === 'uploading' ? '100%' : '0%';
  if (statusEl) {
    if (status === 'done') statusEl.innerHTML = '<i class="ri-check-line" style="color:var(--color-success)"></i>';
    else if (status === 'error') statusEl.innerHTML = '<i class="ri-close-line" style="color:var(--color-danger)"></i>';
    else if (status === 'cancelled') statusEl.textContent = '—';
    else statusEl.textContent = text;
  }
  if (metaEl && status === 'done')
    metaEl.innerHTML = `<span style="color:var(--color-success)">${t('editor.done')}</span>`;
  if (metaEl && status === 'error')
    metaEl.innerHTML = `<span style="color:var(--color-danger)">${escHtml(text)}</span>`;
  if (retryBtn) retryBtn.style.display = status === 'error' ? '' : 'none';
  if (cancelBtn) cancelBtn.style.display = status === 'done' || status === 'cancelled' ? 'none' : '';
}

function progressUI(item, pct) {
  const fill = item.el.querySelector('.upload-item-fill');
  const statusEl = item.el.querySelector('.upload-item-status');
  if (fill) fill.style.width = pct + '%';
  if (statusEl && item.status !== 'cancelled') statusEl.textContent = pct + '%';
}

function cancelItem(item) {
  item.status = 'cancelled';
  if (item._xhrs && item._xhrs.size) {
    for (const xhr of item._xhrs) xhr.abort();
    item._xhrs.clear();
  } else if (item.controller) {
    item.controller.abort();
  }
  item.el.classList.remove('upload-done', 'upload-error');
  setState(item, 'cancelled', '—');
}

function retryItem(item) {
  item.status = 'pending';
  item.el.classList.remove('upload-error');
  const fill = item.el.querySelector('.upload-item-fill');
  const statusEl = item.el.querySelector('.upload-item-status');
  const metaEl = item.el.querySelector('.upload-item-meta');
  if (fill) fill.style.width = '0%';
  if (statusEl) statusEl.textContent = '0%';
  if (metaEl) metaEl.innerHTML = `<span>${fileSize(item.file.size)}</span>`;
  runSingle(item);
}

async function runSingle(item) {
  item.status = 'uploading';
  setState(item, 'uploading', '0%');
  try {
    const ok = await uploadFilePresigned(item);
    if (!ok && item.status !== 'cancelled') await uploadFileDirect(item);
    if (item.status === 'cancelled') return;
    item.status = 'done';
    item.done = true;
    item.el.classList.add('upload-done');
    setState(item, 'done', t('editor.done'));
    window.checkDirty && window.checkDirty();
    window.loadExistingMedia && window.loadExistingMedia(item.slug);
  } catch (err) {
    if (item.status === 'cancelled') return;
    item.status = 'error';
    item.el.classList.add('upload-error');
    setState(item, 'error', err.message || 'Error');
  }
}

async function uploadFilePresigned(item) {
  // Large files: resumable multipart (parts upload straight to R2).
  if (item.file.size > MULTIPART_THRESHOLD) return uploadFileMultipart(item);

  let presigned;
  try {
    presigned = await upload.presign(item.slug, item.file.name, item.file.type || 'application/octet-stream');
  } catch {
    return false;
  }
  const xhr = new XMLHttpRequest();
  item.controller = xhr;
  xhr.open('PUT', presigned.url);
  xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
  xhr.timeout = 600000;
  return new Promise((resolve) => {
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && item.status !== 'cancelled') progressUI(item, Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      item.controller = null;
      if (item.status === 'cancelled') {
        resolve(false);
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        // Confirm the object landed + mark the site dirty. If confirmation
        // fails the upload is NOT silently swallowed — fall back to direct.
        upload
          .complete(item.slug, item.file.name)
          .then(() => resolve(true))
          .catch(() => resolve(false));
      } else {
        resolve(false); // fall back to direct
      }
    });
    xhr.addEventListener('error', () => {
      item.controller = null;
      resolve(false);
    });
    xhr.addEventListener('timeout', () => {
      item.controller = null;
      resolve(false);
    });
    xhr.addEventListener('abort', () => {
      item.controller = null;
      resolve(false);
    });
    xhr.send(item.file);
  });
}

async function uploadFileMultipart(item) {
  const { slug, filename, file } = item;
  const stored = mpLoad(slug, filename, file.size);
  let started;
  try {
    started = await upload.multipartStart(slug, filename, file.size, file.type, stored?.uploadId);
  } catch (e) {
    if (stored && stored.uploadId) {
      // Stale uploadId (aborted/expired server-side) — start a fresh upload.
      mpClear(slug, filename);
      started = await upload.multipartStart(slug, filename, file.size, file.type);
    } else {
      throw e;
    }
  }
  const { uploadId, partSize, partCount, parts } = started;
  mpSave(slug, filename, { uploadId, partSize, partCount, size: file.size });

  let doneSet = new Set();
  if (stored && stored.uploadId) {
    const res = await upload.multipartParts(slug, filename, uploadId).catch(() => ({ parts: [] }));
    doneSet = new Set((res.parts || []).map((p) => p.partNumber));
  }
  item._mpDoneBytes = doneSet.size * partSize;
  progressUI(item, Math.min(99, Math.round((item._mpDoneBytes / file.size) * 100)));
  const pending = parts.filter((p) => !doneSet.has(p.partNumber));

  try {
    await runParts(item, pending, partSize);
  } catch (err) {
    if (item.status === 'cancelled') {
      upload.multipartAbort(slug, filename, uploadId).catch(() => {});
      mpClear(slug, filename);
    }
    throw err;
  }
  await upload.multipartComplete(slug, filename, uploadId);
  mpClear(slug, filename);
  return true;
}

async function runParts(item, pending, partSize) {
  let idx = 0;
  const workers = [];
  for (let i = 0; i < Math.min(MP_CONCURRENCY, pending.length); i++) workers.push(worker());
  await Promise.all(workers);

  async function worker() {
    while (idx < pending.length) {
      const part = pending[idx++];
      if (item.status === 'cancelled') return;
      await uploadPartWithRetry(item, part, partSize);
    }
  }
}

async function uploadPartWithRetry(item, part, partSize) {
  let lastErr;
  for (let attempt = 1; attempt <= MP_PART_RETRIES; attempt++) {
    if (item.status === 'cancelled') throw new Error('Cancelled');
    try {
      await uploadPartXhr(item, part, partSize);
      item._mpDoneBytes += partSize;
      progressUI(item, Math.min(99, Math.round((item._mpDoneBytes / item.file.size) * 100)));
      return;
    } catch (e) {
      if (e.message === 'Cancelled') throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr || new Error('Part upload failed');
}

function uploadPartXhr(item, part, partSize) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (!item._xhrs) item._xhrs = new Set();
    item._xhrs.add(xhr);
    xhr.open('PUT', part.url);
    xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
    xhr.timeout = 600000;
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && item.status !== 'cancelled') {
        progressUI(item, Math.min(99, Math.round(((item._mpDoneBytes + e.loaded) / item.file.size) * 100)));
      }
    });
    const done = () => {
      item._xhrs.delete(xhr);
      item.controller = null;
    };
    xhr.addEventListener('load', () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) resolve(part.partNumber);
      else reject(new Error('HTTP ' + xhr.status + ' (part ' + part.partNumber + ')'));
    });
    xhr.addEventListener('error', () => {
      done();
      reject(new Error('Network error (part ' + part.partNumber + ')'));
    });
    xhr.addEventListener('timeout', () => {
      done();
      reject(new Error('Timeout (part ' + part.partNumber + ')'));
    });
    xhr.addEventListener('abort', () => {
      done();
      reject(new Error('Cancelled'));
    });
    const start = (part.partNumber - 1) * partSize;
    const end = Math.min(item.file.size, start + partSize);
    xhr.send(item.file.slice(start, end));
  });
}

function uploadFileDirect(item) {
  return new Promise((resolve, reject) => {
    const url = upload.directUrl(item.slug, item.file.name);
    const xhr = new XMLHttpRequest();
    item.controller = xhr;
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', 'Bearer ' + item.token);
    xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
    xhr.timeout = 300000;
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && item.status !== 'cancelled') progressUI(item, Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      item.controller = null;
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else if (xhr.status === 413) reject(new Error('文件超过 100MB 且预签名上传失败，无法兜底'));
      else reject(new Error('HTTP ' + xhr.status));
    });
    xhr.addEventListener('error', () => {
      item.controller = null;
      reject(new Error('Network error'));
    });
    xhr.addEventListener('abort', () => {
      item.controller = null;
      reject(new Error('Cancelled'));
    });
    xhr.send(item.file);
  });
}

export function setupUploadZone() {
  const main = document.getElementById('main-content');
  if (!main) return;

  main.addEventListener('click', (e) => {
    const zone = e.target.closest('.upload-zone');
    if (!zone) return;
    zone.querySelector('input[type="file"]')?.click();
  });
  main.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const zone = e.target.closest('.upload-zone');
    if (!zone) return;
    e.preventDefault();
    zone.querySelector('input[type="file"]')?.click();
  });
  main.addEventListener('change', (e) => {
    if (!e.target.closest('#editor-media-input')) return;
    if (e.target.files?.length) handleUploadFiles([...e.target.files]);
    e.target.value = '';
  });
  main.addEventListener('dragover', (e) => {
    const zone = e.target.closest('.upload-zone');
    if (!zone) return;
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('drag-over');
  });
  main.addEventListener('dragleave', (e) => {
    const zone = e.target.closest('.upload-zone');
    if (!zone) return;
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
  });
  main.addEventListener('drop', (e) => {
    const zone = e.target.closest('.upload-zone');
    if (!zone) return;
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) handleUploadFiles([...e.dataTransfer.files]);
  });
}
