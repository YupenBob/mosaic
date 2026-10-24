/**
 * Config form mechanics — collect, validate, save, discard, search and
 * scroll-spy. All risky saves get explicit confirmation and every failure
 * offers an inline retry instead of losing the user's edits.
 */
import { config as configApi } from '../../src/api.js';
import { t } from '../i18n.js?v=1';
import { state } from '../state.js?v=1';
import { toast, modalConfirm, setBtnBusy } from '../ui.js?v=1';

let configDirty = false;

/** Whether the config page has unsaved edits (used by the router guard). */
export function isConfigDirty() {
  return configDirty;
}

function markDirty() {
  configDirty = true;
  updateDirtyUi();
}

/** Called by the router after the user confirms discarding changes. */
export function clearConfigDirty() {
  configDirty = false;
  updateDirtyUi();
}

function updateDirtyUi() {
  const hint = document.getElementById('config-dirty-hint');
  const discard = document.getElementById('config-discard-btn');
  if (hint) hint.style.display = configDirty ? 'block' : 'none';
  if (discard) discard.style.display = configDirty ? '' : 'none';
}

/** Attach dirty tracking to every config control. */
export function wireConfigDirty(signal) {
  document.querySelectorAll('[data-config]').forEach((el) => {
    el.addEventListener('input', markDirty, { signal });
    el.addEventListener('change', markDirty, { signal });
  });
  updateDirtyUi();
}

// ── Serialization ──────────────────────────
function setPath(target, keys, value) {
  let node = target;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!node[keys[i]] || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

/**
 * Collect every `data-config` control into a nested config object.
 * Unchecked radios are skipped; disabled controls keep their value so a
 * temporary dependent-field lock never drops stored settings.
 * @returns {object} Partial config patch for `PUT /api/config`.
 */
export function collectConfigData() {
  const data = {};
  document.querySelectorAll('[data-config]').forEach((el) => {
    if (el.type === 'radio' && !el.checked) return;
    if (el.type === 'file' || el.type === 'hidden') return;
    const kind = el.dataset.type || (el.type === 'checkbox' ? 'bool' : el.type === 'number' ? 'number' : 'text');
    let value;
    if (kind === 'bool') value = !!el.checked;
    else if (kind === 'number') value = el.value === '' ? 0 : Number(el.value);
    else value = el.value;
    setPath(data, el.dataset.config.split('.'), value);
  });
  return data;
}

// ── Validation ─────────────────────────────
function fieldLabel(el) {
  return el.getAttribute('aria-label') || el.dataset.config || '';
}

function showFieldError(el, message) {
  const field = el.closest('.config-field');
  if (!field) return;
  field.classList.add('has-error');
  let error = field.querySelector('.config-error');
  if (!error) {
    error = document.createElement('p');
    error.className = 'config-error';
    field.appendChild(error);
  }
  error.hidden = false;
  error.textContent = message;
  el.setAttribute('aria-invalid', 'true');
}

function clearFieldErrors() {
  document.querySelectorAll('.config-field.has-error').forEach((field) => {
    field.classList.remove('has-error');
    const error = field.querySelector('.config-error');
    if (error) error.hidden = true;
  });
  document.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
}

/**
 * Validate all visible controls using native constraint validation plus the
 * per-field `data-error` message.
 * @returns {{ok:boolean, first:HTMLElement|null}}
 */
export function validateConfigForm() {
  clearFieldErrors();
  let first = null;
  document.querySelectorAll('[data-config]').forEach((el) => {
    if (el.disabled || !el.checkValidity || el.offsetParent === null) return;
    if (el.checkValidity()) return;
    const message =
      el.dataset.errorMessage ||
      (el.dataset.error ? t(el.dataset.error) : t('config.invalidField', { label: fieldLabel(el) }));
    showFieldError(el, message);
    if (!first) first = el;
  });
  return { ok: !first, first };
}

// ── Save / discard ─────────────────────────
/** Deep-merge a patch into a config object (plain objects only). */
function mergeConfig(base, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      base[key] = mergeConfig(base[key] && typeof base[key] === 'object' ? base[key] : {}, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

function interpolationEnabled(cfg) {
  return cfg?.videoQuality?.interpolation?.enabled === true;
}

async function persistConfig(data) {
  const btn = document.querySelector('.page-header .btn-primary');
  setBtnBusy(btn, true);
  try {
    await configApi.update(data);
    state.config = mergeConfig(state.config || {}, data);
    clearConfigDirty();
    window.checkDirty && window.checkDirty();
    window.dispatchEvent(new CustomEvent('mosaic:config-updated'));
    toast(t('config.saved'), 'success');
  } catch (error) {
    toast(t('config.saveFailed') + ': ' + error.message, 'error', 9000, {
      label: t('config.retrySave'),
      onClick: () => persistConfig(data),
    });
  } finally {
    setBtnBusy(btn, false);
  }
}

/**
 * Save the config form. Enabling frame interpolation is expensive (it
 * re-encodes existing videos), so that transition asks for confirmation.
 */
export async function saveConfig() {
  const validation = validateConfigForm();
  if (!validation.ok) {
    validation.first?.focus();
    toast(t('config.fixErrors'), 'error', 6000);
    return;
  }
  const data = collectConfigData();
  if (!interpolationEnabled(state.config) && interpolationEnabled(data)) {
    modalConfirm(t('config.interpConfirmTitle'), t('config.interpConfirmDesc'), () => persistConfig(data), {
      danger: false,
      okLabel: t('config.interpConfirmOk'),
    });
    return;
  }
  await persistConfig(data);
}

/** Discard edits after an explicit confirmation (dirty only). */
export function discardConfig() {
  const reload = () => {
    clearConfigDirty();
    location.hash = 'config&_r=' + Date.now();
  };
  if (!configDirty) {
    reload();
    return;
  }
  modalConfirm(t('config.discardTitle'), t('config.discardMsg'), reload, {
    danger: false,
    okLabel: t('config.discard'),
  });
}

// ── Search ─────────────────────────────────
window.filterConfig = (query) => {
  const q = String(query || '')
    .toLowerCase()
    .trim();
  document.querySelectorAll('.config-field').forEach((field) => {
    field.style.display = !q || (field.textContent || '').toLowerCase().includes(q) ? '' : 'none';
  });
  let visibleSections = 0;
  document.querySelectorAll('.config-section').forEach((section) => {
    const fields = [...section.querySelectorAll('.config-field')];
    const visible = fields.some((field) => field.style.display !== 'none');
    section.style.display = !q || visible ? '' : 'none';
    if (!q || visible) visibleSections++;
    section.querySelectorAll('.config-callout, .config-group-heading').forEach((block) => {
      block.style.display = contentMatches(block, q) ? '' : 'none';
    });
  });
  const empty = document.getElementById('config-no-match');
  if (empty) empty.hidden = visibleSections > 0 || !q;
};

/** Whether a non-field block should stay visible for the current query. */
function contentMatches(el, q) {
  return !q || (el.textContent || '').toLowerCase().includes(q);
}

// ── Scroll-spy ─────────────────────────────
/** Highlight the section currently in view and support click-to-scroll. */
export function setupConfigScrollSpy(signal) {
  const links = document.querySelectorAll('.config-rail a');
  const sections = [...document.querySelectorAll('.config-section')];
  const spy = () => {
    let current = sections[0]?.dataset.section;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 100) current = section.dataset.section;
    }
    links.forEach((link) => link.classList.toggle('active', link.dataset.target === current));
  };
  document.addEventListener('scroll', spy, { passive: true, signal });
  links.forEach((link) => {
    link.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        document.getElementById('config-section-' + link.dataset.target)?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      },
      { signal },
    );
  });
  spy();
}

// Inline handlers used by the config page markup.
window.doSaveConfig = saveConfig;
window.discardConfig = discardConfig;
