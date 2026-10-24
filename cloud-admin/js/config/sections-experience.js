/**
 * Config sections for the experience v2 capabilities:
 * - 体验: big/full-bleed cards, note modal, vertical feed, spring motion, Morphicons.
 * - 视频补帧: ffmpeg minterpolate options with cost/time warning.
 * - 媒体保留源文件: global default for deleting R2 originals after decode.
 *
 * Keys match `shared/config.mjs` exactly (docs/experience-v2-plan.md §3).
 */
import { t } from '../i18n.js?v=1';
import { cfgGet, numberField, selectField, toggleField, segmentedField, callout, previewBlock } from './fields.js?v=1';

// ── Experience ─────────────────────────────
/** Mini card mock reflecting card size/full-image choices. */
function cardPreviewBody() {
  return `
    <div class="card-preview" id="card-preview" data-size="large" data-image="full" aria-hidden="true">
      <div class="card-preview-media">
        <span class="card-preview-category">${t('config.previewCategory')}</span>
        <div class="card-preview-overlay">
          <strong>${t('config.previewCardTitle')}</strong>
          <p>${t('config.previewCardDesc')}</p>
        </div>
      </div>
      <div class="card-preview-body">
        <strong>${t('config.previewCardTitle')}</strong>
        <p>${t('config.previewCardDesc')}</p>
        <div class="card-preview-meta"><span><i class="ri-eye-line"></i> 128</span><span><i class="ri-heart-line"></i> 24</span></div>
      </div>
    </div>
    <p class="config-preview-caption" id="card-preview-caption"></p>
  `;
}

function experienceSection(cfg) {
  return `
    ${callout({ icon: 'ri-sparkling-line', body: t('config.experienceIntro') })}
    ${segmentedField({
      key: 'experience.card.size',
      label: t('config.cardSize'),
      hint: t('config.cardSizeHint'),
      value: cfgGet(cfg, 'experience.card.size', 'large'),
      options: [
        { value: 'large', label: t('config.cardSizeLarge'), hint: t('config.cardSizeLargeHint') },
        { value: 'compact', label: t('config.cardSizeCompact'), hint: t('config.cardSizeCompactHint') },
      ],
    })}
    ${segmentedField({
      key: 'experience.card.image',
      label: t('config.cardImage'),
      hint: t('config.cardImageHint'),
      value: cfgGet(cfg, 'experience.card.image', 'full'),
      options: [
        { value: 'full', label: t('config.cardImageFull'), hint: t('config.cardImageFullHint') },
        { value: 'cover', label: t('config.cardImageCover'), hint: t('config.cardImageCoverHint') },
      ],
    })}
    ${segmentedField({
      key: 'experience.card.layout',
      label: t('config.cardLayout'),
      hint: t('config.cardLayoutHint'),
      value: cfgGet(cfg, 'experience.card.layout', 'masonry'),
      options: [
        { value: 'masonry', label: t('config.cardLayoutMasonry'), hint: t('config.cardLayoutMasonryHint') },
        { value: 'grid', label: t('config.cardLayoutGrid'), hint: t('config.cardLayoutGridHint') },
      ],
    })}
    ${toggleField({
      key: 'experience.modal.enabled',
      label: t('config.modalEnabled'),
      hint: t('config.modalEnabledHint'),
      checked: cfgGet(cfg, 'experience.modal.enabled', true),
    })}
    ${toggleField({
      key: 'experience.verticalFeed.enabled',
      label: t('config.verticalFeedEnabled'),
      hint: t('config.verticalFeedEnabledHint'),
      checked: cfgGet(cfg, 'experience.verticalFeed.enabled', true),
    })}
    ${toggleField({
      key: 'experience.motion.enabled',
      label: t('config.motionEnabled'),
      hint: t('config.motionEnabledHint'),
      checked: cfgGet(cfg, 'experience.motion.enabled', true),
    })}
    ${selectField({
      key: 'experience.motion.spring',
      label: t('config.springPreset'),
      hint: t('config.springPresetHint'),
      value: cfgGet(cfg, 'experience.motion.spring', 'snappy'),
      options: [
        { value: 'none', label: t('config.springNone') },
        { value: 'snappy', label: t('config.springSnappy') },
        { value: 'smooth', label: t('config.springSmooth') },
        { value: 'bouncy', label: t('config.springBouncy') },
      ],
    })}
    ${toggleField({
      key: 'experience.morphIcons.enabled',
      label: t('config.morphIconsEnabled'),
      hint: t('config.morphIconsEnabledHint'),
      checked: cfgGet(cfg, 'experience.morphIcons.enabled', true),
    })}
    ${previewBlock({
      id: 'card-preview-slot',
      title: t('config.cardPreview'),
      hint: t('config.cardPreviewHint'),
      body: cardPreviewBody(),
    })}
  `;
}

// ── Frame interpolation ────────────────────
function videoInterpolationSection(cfg) {
  const enabled = cfgGet(cfg, 'videoQuality.interpolation.enabled', false);
  return `
    ${callout({
      tone: 'warning',
      icon: 'ri-timer-flash-line',
      title: t('config.interpCostTitle'),
      body: t('config.interpCostBody'),
    })}
    ${toggleField({
      key: 'videoQuality.interpolation.enabled',
      label: t('config.interpEnabled'),
      hint: t('config.interpEnabledHint'),
      checked: enabled,
    })}
    <div class="config-dep-group" data-depends="videoQuality.interpolation.enabled">
      ${numberField({
        key: 'videoQuality.interpolation.fps',
        label: t('config.interpFps'),
        hint: t('config.interpFpsHint'),
        value: cfgGet(cfg, 'videoQuality.interpolation.fps', 60),
        min: 24,
        max: 120,
        step: 1,
        width: '120px',
        error: t('config.interpFpsInvalid'),
      })}
      ${selectField({
        key: 'videoQuality.interpolation.mode',
        label: t('config.interpMode'),
        hint: t('config.interpModeHint'),
        value: cfgGet(cfg, 'videoQuality.interpolation.mode', 'mci'),
        options: [
          { value: 'mci', label: t('config.interpModeMci') },
          { value: 'blend', label: t('config.interpModeBlend') },
          { value: 'dup', label: t('config.interpModeDup') },
        ],
      })}
      <div class="config-dep-group" data-depends-mode="videoQuality.interpolation.mode" data-depends-mode-value="mci">
        ${selectField({
          key: 'videoQuality.interpolation.mcMode',
          label: t('config.interpMcMode'),
          hint: t('config.interpMcModeHint'),
          value: cfgGet(cfg, 'videoQuality.interpolation.mcMode', 'aobmc'),
          options: [
            { value: 'aobmc', label: t('config.interpMcAobmc') },
            { value: 'vmm', label: t('config.interpMcVmm') },
            { value: 'obmc', label: t('config.interpMcObmc') },
          ],
        })}
        ${selectField({
          key: 'videoQuality.interpolation.meMode',
          label: t('config.interpMeMode'),
          hint: t('config.interpMeModeHint'),
          value: cfgGet(cfg, 'videoQuality.interpolation.meMode', 'bidir'),
          options: [
            { value: 'bidir', label: t('config.interpMeBidir') },
            { value: 'epzs', label: t('config.interpMeEpzs') },
            { value: 'esa', label: t('config.interpMeEsa') },
          ],
        })}
        ${toggleField({
          key: 'videoQuality.interpolation.vsbmc',
          label: t('config.interpVsbmc'),
          hint: t('config.interpVsbmcHint'),
          checked: cfgGet(cfg, 'videoQuality.interpolation.vsbmc', true),
        })}
      </div>
    </div>
    ${callout({ icon: 'ri-information-line', body: t('config.interpNote') })}
  `;
}

// ── Keep source files ──────────────────────
function keepSourceSection(cfg) {
  const keep = cfgGet(cfg, 'media.keepSourceFiles', true);
  return `
    ${callout({
      tone: 'danger',
      icon: 'ri-error-warning-line',
      title: t('config.keepSourceTitle'),
      body: t('config.keepSourceWarning'),
      id: 'keep-source-warning',
    })}
    ${toggleField({
      key: 'media.keepSourceFiles',
      label: t('config.keepSource'),
      hint: t('config.keepSourceHint'),
      checked: keep,
    })}
    ${callout({ icon: 'ri-information-line', body: t('config.keepSourcePerUpload') })}
  `;
}

/** Section descriptors consumed by the config page shell. */
export const experienceSections = [
  { id: 'experience', icon: 'ri-sparkling-line', label: () => t('config.experience'), body: experienceSection },
  {
    id: 'interpolation',
    icon: 'ri-film-line',
    label: () => t('config.videoInterpolation'),
    body: videoInterpolationSection,
  },
  {
    id: 'keep-source',
    icon: 'ri-database-2-line',
    label: () => t('config.keepSourceSection'),
    body: keepSourceSection,
  },
];
