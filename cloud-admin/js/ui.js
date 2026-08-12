/**
 * UI toolkit — escaping, toasts, modals, empty states, badges, clipboard,
 * dynamic script loading and formatting helpers.
 */
import { t } from './i18n.js?v=1';

export function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('time.justNow');
  if (mins < 60) return t('time.minutesAgo', { n: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('time.hoursAgo', { n: hrs });
  const days = Math.floor(hrs / 24);
  if (days < 7) return t('time.daysAgo', { n: days });
  return d.toLocaleDateString(localStorage.getItem('mosaic_admin_lang') === 'en' ? 'en-US' : 'zh-CN', {
    month: 'short',
    day: 'numeric',
  });
}

export function fmtDuration(sec) {
  if (!sec || sec < 0) return '';
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return m + 'm ' + s + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm ' + s + 's';
}

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

export function debounce(fn, ms) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
}

// ── Toast ────────────────────────────────────────────────────
export function toast(msg, type = 'info', duration = 5000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }
  const icons = {
    success: 'ri-check-line',
    error: 'ri-close-line',
    warning: 'ri-error-warning-line',
    info: 'ri-information-line',
  };
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.innerHTML = `
    <span class="toast-icon"><i class="${icons[type] || icons.info}"></i></span>
    <span class="toast-msg">${escHtml(msg)}</span>
    <button class="toast-close" aria-label="Close"><i class="ri-close-line"></i></button>
  `;
  let progressEl = null;
  if (duration > 0) {
    progressEl = document.createElement('span');
    progressEl.className = 'toast-progress';
    el.appendChild(progressEl);
  }
  const dismiss = () => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-close').addEventListener('click', dismiss);
  container.appendChild(el);
  if (duration > 0) {
    requestAnimationFrame(() => {
      if (progressEl) {
        progressEl.style.width = '100%';
        progressEl.style.transition = `width ${duration}ms linear`;
        requestAnimationFrame(() => {
          progressEl.style.width = '0%';
        });
      }
    });
    setTimeout(dismiss, duration);
  }
}

// ── Modal ────────────────────────────────────────────────────
let _activeModal = null;

export function closeModal() {
  if (_activeModal) {
    _activeModal.remove();
    _activeModal = null;
    const last = document.querySelector('[data-modal-focus-restore]');
    if (last) last.focus();
  }
}

export function openModal({
  title = '',
  desc = '',
  icon = null,
  iconColor = '',
  content = '',
  actions = [],
  wide = false,
  focusSelector = null,
}) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title);
  overlay.innerHTML = `
    <div class="modal-box ${wide ? 'modal-wide' : ''}">
      ${icon ? `<div class="modal-icon" style="${iconColor ? 'color:' + iconColor : ''}"><i class="${icon}"></i></div>` : ''}
      ${title ? `<h3 class="modal-title">${title}</h3>` : ''}
      ${desc ? `<p class="modal-desc">${desc}</p>` : ''}
      ${content || ''}
      <div class="modal-actions"></div>
    </div>
  `;
  const prev = document.activeElement;
  prev && prev.setAttribute('data-modal-focus-restore', '1');
  document.body.appendChild(overlay);
  _activeModal = overlay;

  const actionsEl = overlay.querySelector('.modal-actions');
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (a.className || 'btn-secondary');
    btn.innerHTML = a.html || `<i class="${a.icon || ''}"></i> ${escHtml(a.label)}`;
    btn.onclick = async (e) => {
      if (a.closeOnClick !== false) closeModal();
      if (a.onClick) await a.onClick(e);
    };
    actionsEl.appendChild(btn);
  }
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal();
    }
    if (e.key === 'Tab') {
      const focusables = overlay.querySelectorAll('button, input, select, textarea, a[href]');
      if (!focusables.length) return;
      const first = focusables[0],
        last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  requestAnimationFrame(() => {
    const target = focusSelector ? overlay.querySelector(focusSelector) : overlay.querySelector('input, button');
    if (target) target.focus();
  });
  return overlay;
}

export function modalConfirm(title, desc, onOk, opts = {}) {
  const { danger = true, okLabel = '', requireText = null, wide = false } = opts;
  let content = '';
  if (requireText) {
    content = `
      <div class="modal-field">
        <label>${escHtml(opts.confirmLabel || t('cleanup.typeToConfirm', { n: requireText }))}</label>
        <input type="text" class="input" id="modal-confirm-input" autocomplete="off" />
        <p class="modal-danger-text" style="display:none;color:var(--color-danger)" id="modal-confirm-error">${escHtml(opts.confirmLabel || t('cleanup.typeToConfirm', { n: requireText }))}</p>
      </div>
    `;
  }
  const overlay = openModal({
    title,
    desc,
    icon: danger ? 'ri-error-warning-line' : 'ri-question-line',
    iconColor: danger ? 'var(--color-danger)' : 'var(--color-accent)',
    content,
    wide,
    actions: [
      { label: t('common.cancel'), className: 'btn-secondary', onClick: () => {} },
      {
        label: okLabel || (danger ? t('common.confirmDelete') : t('common.confirm')),
        className: danger ? 'btn-danger' : 'btn-primary',
        icon: danger ? 'ri-delete-bin-line' : 'ri-check-line',
        closeOnClick: false,
        onClick: async () => {
          if (requireText) {
            const input = document.getElementById('modal-confirm-input');
            const err = document.getElementById('modal-confirm-error');
            if (!input || input.value.trim() !== requireText) {
              if (err) err.style.display = 'block';
              input && input.focus();
              return;
            }
          }
          closeModal();
          await onOk();
        },
      },
    ],
    focusSelector: requireText ? '#modal-confirm-input' : null,
  });
  return overlay;
}

export function modalInput({
  title,
  desc = '',
  label = '',
  value = '',
  placeholder = '',
  okLabel = t('common.confirm'),
  validate = null,
  onOk,
}) {
  openModal({
    title,
    desc,
    icon: 'ri-edit-line',
    iconColor: 'var(--color-accent)',
    content: `
      <div class="modal-field">
        ${label ? `<label>${escHtml(label)}</label>` : ''}
        <input type="text" class="input" id="modal-input" value="${escHtml(value)}" placeholder="${escHtml(placeholder)}" autocomplete="off" />
        <p class="modal-danger-text" style="display:none;color:var(--color-danger)" id="modal-input-error"></p>
      </div>
    `,
    actions: [
      { label: t('common.cancel'), className: 'btn-secondary', onClick: () => {} },
      {
        label: okLabel,
        className: 'btn-primary',
        closeOnClick: false,
        onClick: async () => {
          const input = document.getElementById('modal-input');
          const err = document.getElementById('modal-input-error');
          const val = input.value.trim();
          if (validate) {
            const msg = await validate(val);
            if (msg) {
              err.textContent = msg;
              err.style.display = 'block';
              input.focus();
              return;
            }
          }
          closeModal();
          await onOk(val);
        },
      },
    ],
    focusSelector: '#modal-input',
  });
}

// ── Small presentational helpers ─────────────────────────────
export function emptyState(icon, title, desc = '', ctaHtml = '') {
  return `
    <div class="empty-state">
      <i class="${icon}" aria-hidden="true"></i>
      <h3>${escHtml(title)}</h3>
      ${desc ? `<p>${escHtml(desc)}</p>` : ''}
      ${ctaHtml}
    </div>
  `;
}

export function getStatusDef(status, conclusion) {
  if (status === 'in_progress' || status === 'queued') {
    return {
      label: status === 'queued' ? t('build.queued') : t('build.running'),
      cls: 'badge-warning',
      color: 'var(--color-warning)',
      dot: 'busy',
    };
  }
  if (conclusion === 'success')
    return { label: t('build.success'), cls: 'badge-success', color: 'var(--color-success)', dot: 'ok' };
  if (conclusion === 'failure')
    return { label: t('build.failed'), cls: 'badge-danger', color: 'var(--color-danger)', dot: 'down' };
  if (conclusion === 'cancelled')
    return { label: t('build.cancelled'), cls: 'badge-neutral', color: 'var(--color-text-tertiary)', dot: '' };
  if (conclusion === 'skipped')
    return { label: t('build.skipped'), cls: 'badge-neutral', color: 'var(--color-text-tertiary)', dot: '' };
  return { label: status || t('common.unknown'), cls: 'badge-neutral', color: 'var(--color-text-tertiary)', dot: '' };
}

export function statusBadge(def) {
  return `<span class="badge ${def.cls}"><span class="status-dot ${def.dot}" style="width:7px;height:7px"></span>${escHtml(def.label)}</span>`;
}

export function statusPill(label, cls = 'badge-neutral') {
  return `<span class="badge ${cls}">${escHtml(label)}</span>`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(t('common.copied'), 'success', 1800);
}

const _libCache = {};
export function loadLib(src) {
  if (_libCache[src]) return _libCache[src];
  const p = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => {
      resolve();
    };
    el.onerror = () => {
      delete _libCache[src];
      reject(new Error('Failed to load ' + src));
    };
    document.head.appendChild(el);
  });
  _libCache[src] = p;
  return p;
}

export function setBtnBusy(btn, busy, busyHtml) {
  if (!btn) return;
  if (busy) {
    btn.dataset.restore = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = busyHtml || '<span class="btn-spinner"></span> ' + t('common.loading');
  } else {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.restore || btn.innerHTML;
  }
}

export function quick(promiseFn, fallback, ms = 15000) {
  return Promise.race([
    Promise.resolve()
      .then(promiseFn)
      .catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);
}
