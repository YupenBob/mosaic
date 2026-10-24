/**
 * Live config behaviors: theme/card previews and dependent-field syncing.
 *
 * Pure DOM decoration — never reads/writes config storage. Called from the
 * config page `onMount` with the page's AbortSignal so navigation disposes it.
 */
import { t } from '../i18n.js?v=1';
import { ACCENTS, accentLabel } from './sections-general.js?v=1';

const ACCENT_COLORS = Object.fromEntries(ACCENTS.map((accent) => [accent.value, accent.color]));

/** Resolve the front-end effective mode from `auto|light|dark`. */
function resolveMode(mode) {
  if (mode === 'dark' || mode === 'light') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function checkedValue(root, key) {
  const input = root.querySelector(`[data-config="${key}"]:checked`);
  return input ? input.value : '';
}

/** Mount the theme mode + accent preview inside the config page. */
function mountThemePreview(root, signal) {
  const card = root.querySelector('#theme-preview-card');
  const caption = root.querySelector('#theme-preview-caption');
  if (!card) return;
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const render = () => {
    const mode = checkedValue(root, 'themeMode.default') || 'auto';
    const accent = checkedValue(root, 'themeMode.accent') || 'blue';
    card.dataset.previewMode = resolveMode(mode);
    card.dataset.previewAccent = accent;
    card.style.setProperty('--preview-accent', ACCENT_COLORS[accent] || ACCENT_COLORS.blue);
    if (caption) {
      caption.textContent = t('config.previewCaption', {
        mode: t(`config.theme${mode === 'auto' ? 'Auto' : mode === 'light' ? 'Light' : 'Dark'}`),
        accent: accentLabel(accent),
      });
    }
  };

  root.addEventListener(
    'change',
    (event) => {
      if (event.target.matches('[data-config^="themeMode."]')) render();
    },
    { signal },
  );
  media.addEventListener('change', render, { signal });
  render();
}

/** Mount the card-size / full-image preview. */
function mountCardPreview(root, signal) {
  const card = root.querySelector('#card-preview');
  const caption = root.querySelector('#card-preview-caption');
  if (!card) return;
  const render = () => {
    const size = checkedValue(root, 'experience.card.size') || 'large';
    const image = checkedValue(root, 'experience.card.image') || 'full';
    card.dataset.size = size;
    card.dataset.image = image;
    if (caption) {
      caption.textContent = t('config.cardPreviewCaption', {
        size: t(size === 'large' ? 'config.cardSizeLarge' : 'config.cardSizeCompact'),
        image: t(image === 'full' ? 'config.cardImageFull' : 'config.cardImageCover'),
      });
    }
  };
  root.addEventListener(
    'change',
    (event) => {
      if (event.target.matches('[data-config^="experience.card."]')) render();
    },
    { signal },
  );
  render();
}

/** Enable/disable fields that only apply when their parent toggle is on. */
function syncDependentFields(root) {
  const sync = () => {
    root.querySelectorAll('.config-dep-group[data-depends]').forEach((group) => {
      const master = root.querySelector(`[data-config="${group.dataset.depends}"]`);
      const enabled = !master || !!master.checked;
      const modeKey = group.dataset.dependsMode;
      let modeOk = true;
      if (modeKey) {
        const modeControl = root.querySelector(`[data-config="${modeKey}"]`);
        modeOk = !modeControl || modeControl.value === group.dataset.dependsModeValue;
      }
      const active = enabled && modeOk;
      group.classList.toggle('is-disabled', !active);
      group.querySelectorAll('input, select, textarea').forEach((control) => {
        control.disabled = !active;
        control.setAttribute('aria-disabled', active ? 'false' : 'true');
      });
    });
  };
  root.addEventListener('change', sync);
  sync();
}

/** Highlight the keep-source warning while its toggle is off. */
function syncKeepSourceWarning(root) {
  const warning = root.querySelector('#keep-source-warning');
  const toggle = root.querySelector('[data-config="media.keepSourceFiles"]');
  if (!warning || !toggle) return;
  const sync = () => warning.classList.toggle('is-armed', !toggle.checked);
  root.addEventListener('change', (event) => {
    if (event.target === toggle) sync();
  });
  sync();
}

/**
 * Wire all live behaviors of the config page.
 * @param {ParentNode} root Page root (usually `#main-content`).
 * @param {AbortSignal} signal Page scope signal.
 */
export function mountConfigLive(root, signal) {
  mountThemePreview(root, signal);
  mountCardPreview(root, signal);
  syncDependentFields(root);
  syncKeepSourceWarning(root);
}
