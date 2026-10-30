/**
 * Video enhancement page. This is intentionally separate from the media
 * library: interpolation/re-encoding creates a new generation and is a
 * deliberate, potentially long-running operation.
 */
import { assets as assetsApi, mediaJobs } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { escHtml, toast, emptyState } from './ui.js?v=1';

export default async function renderEnhance(signal) {
  let videos = [];
  try {
    const result = await assetsApi.list({ includeDeleted: 0 });
    videos = (result.assets || []).filter((asset) => asset.folder === 'videos');
  } catch {}
  if (signal.aborted) return '';

  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>${t('nav.enhance')}</h1>
            <p class="page-subtitle">${t('enhance.subtitle')}</p>
          </div>
        </div>
        ${
          videos.length
            ? `<form id="enhance-form" class="enhance-layout">
                <section class="card card-pad">
                  <div class="editor-section-title">${t('enhance.pickVideos')}</div>
                  <div class="enhance-list">
                    ${videos
                      .map(
                        (video) => `<label class="enhance-video">
                          <input type="checkbox" name="asset" value="${escHtml(video.id)}" />
                          <span class="enhance-video-name">${escHtml(video.filename)}</span>
                          <span class="enhance-video-meta">${escHtml(video.status)} · ${video.sourceAvailable === false ? t('enhance.sourceGone') : t('enhance.sourceReady')}</span>
                        </label>`,
                      )
                      .join('')}
                  </div>
                </section>
                <section class="card card-pad">
                  <div class="editor-section-title">${t('enhance.options')}</div>
                  <label class="field"><span>${t('enhance.operation')}</span>
                    <select id="enhance-operation">
                      <option value="interpolate">${t('enhance.interpolate')}</option>
                      <option value="reencode">${t('enhance.reencode')}</option>
                      <option value="both">${t('enhance.both')}</option>
                    </select>
                  </label>
                  <label class="field"><span>${t('enhance.sourceMode')}</span>
                    <select id="enhance-source-mode">
                      <option value="processed">${t('enhance.processed')}</option>
                      <option value="original">${t('enhance.original')}</option>
                    </select>
                    <small class="field-hint">${t('enhance.sourceHint')}</small>
                  </label>
                  <label class="field" id="enhance-fps-field"><span>${t('enhance.fps')}</span>
                    <select id="enhance-fps"><option value="60">60</option><option value="120">120</option></select>
                  </label>
                  <div id="enhance-reencode-fields" hidden>
                    <label class="field"><span>CRF</span><input type="number" id="enhance-crf" min="0" max="51" value="23" /></label>
                    <label class="field"><span>${t('enhance.preset')}</span>
                      <select id="enhance-preset"><option value="veryfast">veryfast</option><option value="fast">fast</option><option value="medium">medium</option><option value="slow">slow</option></select>
                    </label>
                    <label class="field"><span>${t('enhance.audio')}</span><select id="enhance-audio"><option value="128k">128k</option><option value="96k">96k</option><option value="192k">192k</option></select></label>
                  </div>
                  <button type="submit" class="btn btn-primary" id="enhance-submit"><i class="ri-magic-line" aria-hidden="true"></i> ${t('enhance.start')}</button>
                  <p class="field-hint">${t('enhance.note')}</p>
                </section>
              </form>
              <div id="enhance-result" aria-live="polite"></div>`
            : emptyState(
                'ri-video-line',
                t('enhance.emptyTitle'),
                t('enhance.emptyDesc'),
                `<a class="btn btn-secondary" href="#library">${t('enhance.goLibrary')}</a>`,
              )
        }
      </div>
    `,
    onMount() {
      const form = document.getElementById('enhance-form');
      if (!form) return;
      const operation = document.getElementById('enhance-operation');
      const sync = () => {
        const reencode = ['reencode', 'both'].includes(operation.value);
        const interpolate = ['interpolate', 'both'].includes(operation.value);
        document.getElementById('enhance-reencode-fields').hidden = !reencode;
        document.getElementById('enhance-fps-field').hidden = !interpolate;
      };
      operation.addEventListener('change', sync);
      sync();
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const selected = [...form.querySelectorAll('input[name="asset"]:checked')].map((input) => input.value);
        if (!selected.length) {
          toast(t('enhance.pickOne'), 'info');
          return;
        }
        const body = {
          assetIds: selected,
          operation: operation.value,
          sourceMode: document.getElementById('enhance-source-mode').value,
        };
        if (['interpolate', 'both'].includes(operation.value))
          body.fps = Number(document.getElementById('enhance-fps').value);
        if (['reencode', 'both'].includes(operation.value))
          body.reencode = {
            crf: Number(document.getElementById('enhance-crf').value),
            preset: document.getElementById('enhance-preset').value,
            audioBitrate: document.getElementById('enhance-audio').value,
          };
        const button = document.getElementById('enhance-submit');
        button.disabled = true;
        try {
          const result = await mediaJobs.interpolate(body);
          toast(t('enhance.started', { n: result.enqueued ?? 0 }), 'success');
          document.getElementById('enhance-result').innerHTML =
            `<div class="card card-pad">${t('enhance.startedHint')} <a href="#tasks">${t('nav.tasks')}</a></div>`;
        } catch (error) {
          toast(t('enhance.failed') + ': ' + (error.message || ''), 'error');
        } finally {
          button.disabled = false;
        }
      });
    },
  };
}

export const enhanceSkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:160px;height:30px"></div></div>
    <div class="skeleton-card">${[1, 2, 3].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
  </div>
`;
