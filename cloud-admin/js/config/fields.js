/**
 * Reusable configuration form field builders.
 *
 * Every builder returns a `.config-field` block. Form controls carry a
 * `data-config` attribute (dotted config path) so `config/form.js` can
 * serialize them generically; labels/hints arrive pre-translated from the
 * section modules, so this file stays i18n-free and directly reusable.
 *
 * Builders never read `state` and have no side effects: sections are pure
 * (cfg) -> HTML strings, which keeps them easy to test and to reason about.
 */
import { escHtml } from '../ui.js?v=1';

/**
 * Read a dotted path from a config object.
 * @param {object} obj Config object (may be empty/partial).
 * @param {string} path Dotted path, e.g. `themeMode.default`.
 * @param {*} [fallback] Value returned when the path is missing/null.
 * @returns {*} Resolved value or fallback.
 */
export function cfgGet(obj, path, fallback = '') {
  const value = String(path)
    .split('.')
    .reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), obj);
  return value === undefined || value === null ? fallback : value;
}

/** Render a whole-width `.config-field` stack (used by previews and groups). */
function block(inner, { className = '', id = '' } = {}) {
  return `<div class="config-field config-field--stack${className ? ' ' + className : ''}"${id ? ` id="${id}"` : ''}>${inner}</div>`;
}

/** Label column used by all standard rows. */
function labelHtml(label, hint) {
  return `<label class="config-label"><span>${escHtml(label)}</span>${hint ? `<small>${escHtml(hint)}</small>` : ''}</label>`;
}

/** Inline validation message placeholder (filled by config/form.js). */
function errorHtml(message = '') {
  return `<p class="config-error" hidden>${escHtml(message)}</p>`;
}

/**
 * Standard single-line text input row.
 * @param {{key:string,label:string,hint?:string,value?:*,type?:string,inputId?:string,placeholder?:string,error?:string}} options
 */
export function textField({
  key,
  label,
  hint = '',
  value = '',
  type = 'text',
  inputId = '',
  placeholder = '',
  error = '',
}) {
  return `<div class="config-field">${labelHtml(label, hint)}<input type="${escHtml(type)}" class="input" data-config="${escHtml(key)}" ${inputId ? `id="${escHtml(inputId)}"` : ''} aria-label="${escHtml(label)}" value="${escHtml(String(value))}"${placeholder ? ` placeholder="${escHtml(placeholder)}"` : ''} />${errorHtml(error)}</div>`;
}

/**
 * Multi-line textarea row.
 * @param {{key:string,label:string,hint?:string,value?:*,rows?:number}} options
 */
export function textAreaField({ key, label, hint = '', value = '', rows = 2 }) {
  return `<div class="config-field">${labelHtml(label, hint)}<textarea class="textarea" data-config="${escHtml(key)}" aria-label="${escHtml(label)}" rows="${rows}">${escHtml(String(value))}</textarea></div>`;
}

/**
 * Numeric input row with browser-level range/step validation.
 * @param {{key:string,label:string,hint?:string,value?:*,min?:number,max?:number,step?:number,width?:string,inputId?:string,error?:string}} options
 */
export function numberField({
  key,
  label,
  hint = '',
  value = 0,
  min,
  max,
  step = 1,
  width = '',
  inputId = '',
  error = '',
}) {
  const range = `${min === undefined ? '' : ` min="${min}"`}${max === undefined ? '' : ` max="${max}"`}`;
  return `<div class="config-field">${labelHtml(label, hint)}<input type="number" class="input" data-config="${escHtml(key)}" data-type="number"${inputId ? ` id="${escHtml(inputId)}"` : ''} aria-label="${escHtml(label)}" value="${escHtml(String(value))}"${range} step="${step}"${error ? ` data-error-message="${escHtml(error)}"` : ''}${width ? ` style="width:${width}"` : ''} />${errorHtml(error)}</div>`;
}

/**
 * Select row.
 * @param {{key:string,label:string,hint?:string,value?:*,options:Array<{value:string,label:string}>}} options
 */
export function selectField({ key, label, hint = '', value = '', options }) {
  return `<div class="config-field">${labelHtml(label, hint)}<select class="select" data-config="${escHtml(key)}" aria-label="${escHtml(label)}">${options
    .map(
      (option) =>
        `<option value="${escHtml(option.value)}"${String(value) === String(option.value) ? ' selected' : ''}>${escHtml(option.label)}</option>`,
    )
    .join('')}</select></div>`;
}

/**
 * Boolean toggle row (styled checkbox switch).
 * @param {{key:string,label:string,hint?:string,checked?:boolean}} options
 */
export function toggleField({ key, label, hint = '', checked = false }) {
  return `<div class="config-field">${labelHtml(label, hint)}<label class="toggle-switch"><input type="checkbox" data-config="${escHtml(key)}" data-type="bool" aria-label="${escHtml(label)}" ${checked ? 'checked' : ''} /><span class="toggle-slider"></span></label></div>`;
}

/**
 * Segmented radio group — compact mutually exclusive choice with inline help.
 * @param {{key:string,label:string,hint?:string,value?:string,options:Array<{value:string,label:string,hint?:string}>}} options
 */
export function segmentedField({ key, label, hint = '', value = '', options }) {
  const groupLabel = escHtml(label);
  return `<div class="config-field config-field--stack">
    <div class="config-label"><span>${escHtml(label)}</span>${hint ? `<small>${escHtml(hint)}</small>` : ''}</div>
    <div class="segmented" role="radiogroup" aria-label="${groupLabel}">
      ${options
        .map(
          (option) => `<label class="segmented-option${String(value) === String(option.value) ? ' is-active' : ''}">
            <input type="radio" name="seg-${escHtml(key)}" value="${escHtml(option.value)}" data-config="${escHtml(key)}" data-type="radio" aria-label="${escHtml(option.label)}" ${String(value) === String(option.value) ? 'checked' : ''} />
            <span>${escHtml(option.label)}</span>${option.hint ? `<small>${escHtml(option.hint)}</small>` : ''}
          </label>`,
        )
        .join('')}
    </div>
  </div>`;
}

/**
 * Accent color swatch radio group with visible color dots.
 * @param {{key:string,label:string,hint?:string,value?:string,options:Array<{value:string,label:string,color:string}>}} options
 */
export function swatchField({ key, label, hint = '', value = '', options }) {
  return `<div class="config-field config-field--stack">
    <div class="config-label"><span>${escHtml(label)}</span>${hint ? `<small>${escHtml(hint)}</small>` : ''}</div>
    <div class="swatches" role="radiogroup" aria-label="${escHtml(label)}">
      ${options
        .map(
          (
            option,
          ) => `<label class="swatch${String(value) === String(option.value) ? ' is-active' : ''}" title="${escHtml(option.label)}">
            <input type="radio" name="swatch-${escHtml(key)}" value="${escHtml(option.value)}" data-config="${escHtml(key)}" data-type="radio" aria-label="${escHtml(option.label)}" ${String(value) === String(option.value) ? 'checked' : ''} />
            <span class="swatch-dot" style="--swatch-color:${escHtml(option.color)}"></span>
            <span class="swatch-name">${escHtml(option.label)}</span>
          </label>`,
        )
        .join('')}
    </div>
  </div>`;
}

/**
 * Informational / warning callout used to explain risky settings.
 * @param {{tone?:'info'|'warning'|'danger',icon?:string,title?:string,body:string,id?:string}} options
 */
export function callout({ tone = 'info', icon = 'ri-information-line', title = '', body, id = '' }) {
  return `<div class="config-callout config-callout--${tone}"${id ? ` id="${escHtml(id)}"` : ''} role="note">
    <i class="${escHtml(icon)}" aria-hidden="true"></i>
    <div>${title ? `<strong>${escHtml(title)}</strong>` : ''}<p>${escHtml(body)}</p></div>
  </div>`;
}

/**
 * Full-width preview row. `body` is trusted markup rendered by the section.
 * @param {{id:string,title:string,hint?:string,body:string}} options
 */
export function previewBlock({ id, title, hint = '', body }) {
  return block(
    `<div class="config-label"><span>${escHtml(title)}</span>${hint ? `<small>${escHtml(hint)}</small>` : ''}</div><div class="config-preview" id="${escHtml(id)}">${body}</div>`,
  );
}

/**
 * Sub-group heading inside a section (visual separator without a new card).
 * @param {string} title Translated heading.
 * @param {string} [hint] Optional help text.
 */
export function groupHeading(title, hint = '') {
  return `<div class="config-group-heading" role="heading" aria-level="3"><span>${escHtml(title)}</span>${hint ? `<small>${escHtml(hint)}</small>` : ''}</div>`;
}
