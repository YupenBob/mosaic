/**
 * Theme packages: built-in default micro-options and full external themes.
 * Applying writes mosaic.config.json; the user still explicitly goes live.
 */
import { themes as themesApi } from '../src/api.js';
import { escHtml, toast, emptyState } from './ui.js?v=1';

function optionField(key, option, value) {
  const id = `theme-${key}`;
  const label = `<label class="field" for="${id}"><span>${escHtml(option.label || key)}</span>`;
  if (option.type === 'boolean')
    return `<label class="theme-switch"><input type="checkbox" id="${id}" data-option="${escHtml(key)}" ${value ? 'checked' : ''}/> <span>${escHtml(option.label || key)}</span>${option.description ? `<small class="field-hint">${escHtml(option.description)}</small>` : ''}</label>`;
  let control;
  if (option.type === 'select')
    control = `<select id="${id}" data-option="${escHtml(key)}">${(option.options || [])
      .map((item) => {
        const itemValue = String(item.value ?? item);
        return `<option value="${escHtml(itemValue)}" ${String(value) === itemValue ? 'selected' : ''}>${escHtml(item.label || itemValue)}</option>`;
      })
      .join('')}</select>`;
  else if (option.type === 'color')
    control = `<input type="color" id="${id}" data-option="${escHtml(key)}" value="${escHtml(value || option.default || '#4361ee')}" />`;
  else if (option.type === 'number')
    control = `<input type="number" id="${id}" data-option="${escHtml(key)}" value="${escHtml(value ?? option.default ?? '')}" />`;
  else
    control = `<input type="text" id="${id}" data-option="${escHtml(key)}" value="${escHtml(value ?? option.default ?? '')}" />`;
  return `${label}${control}${option.description ? `<small class="field-hint">${escHtml(option.description)}</small>` : ''}</label>`;
}

export default async function renderThemes(signal) {
  let data = { themes: [], current: {} };
  let failed = false;
  try {
    data = await themesApi.list();
  } catch {
    failed = true;
  }
  if (signal.aborted) return '';

  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>主题</h1>
            <p class="page-subtitle">选择主题包，调整默认主题的少量选项；完整主题放在 <code>themes/&lt;id&gt;/</code>。</p>
          </div>
        </div>
        ${failed ? `<div class="card card-pad page-load-error" role="alert">主题列表加载失败。检查 Worker 的 GitHub 权限。</div>` : ''}
        <div class="theme-grid" id="theme-grid">
          ${
            data.themes?.length
              ? data.themes
                  .map(
                    (
                      theme,
                    ) => `<article class="card theme-card ${theme.current ? 'is-current' : ''}" data-theme-id="${escHtml(theme.id)}">
                      <div class="theme-card-head">
                        <div>
                          <h2>${escHtml(theme.name)} ${theme.current ? '<span class="badge badge-success">使用中</span>' : ''}</h2>
                          <p class="field-hint">${escHtml(theme.id)} · v${escHtml(theme.version || '0.0.0')}</p>
                        </div>
                      </div>
                      <p class="theme-desc">${escHtml(theme.description || '')}</p>
                      <div class="theme-options">
                        ${Object.entries(theme.options || {})
                          .map(([key, option]) => optionField(key, option, theme.values?.[key] ?? option.default))
                          .join('')}
                      </div>
                      <button type="button" class="btn btn-primary btn-sm" data-apply-theme="${escHtml(theme.id)}">${theme.current ? '保存选项' : '使用这个主题'}</button>
                    </article>`,
                  )
                  .join('')
              : emptyState('ri-palette-line', '还没有主题包', '在 themes/ 下放一个 theme.json 和 layouts/。')
          }
        </div>
        <p class="field-hint">主题变更会提交 mosaic.config.json，随后到「上线」构建；不会自动发布网站。</p>
      </div>
    `,
    onMount() {
      const grid = document.getElementById('theme-grid');
      grid?.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-apply-theme]');
        if (!button) return;
        const id = button.dataset.applyTheme;
        const card = button.closest('.theme-card');
        const options = {};
        for (const input of card.querySelectorAll('[data-option]')) {
          const key = input.dataset.option;
          options[key] =
            input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
        }
        button.disabled = true;
        try {
          await themesApi.apply(id, options);
          toast('主题已保存，去「上线」构建后生效', 'success');
          location.reload();
        } catch (error) {
          toast('应用失败：' + (error.message || ''), 'error');
          button.disabled = false;
        }
      });
    },
  };
}

export const themesSkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:120px;height:30px"></div></div>
    <div class="theme-grid">${[1, 2].map(() => '<div class="skeleton-card"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div>').join('')}</div>
  </div>
`;
