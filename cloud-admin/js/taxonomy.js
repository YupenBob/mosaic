/**
 * Taxonomy page — category tree + tag list with rename (modal), add
 * (opens editor prefilled) and delete (Worker endpoint, hidden when absent).
 */
import { taxonomy } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { escHtml, toast, modalConfirm, modalInput, emptyState } from './ui.js?v=1';

let deleteSupported = null;

export default async function renderTaxonomy(signal) {
  let tax = { categories: [], tags: [] };
  try {
    tax = await taxonomy.get();
  } catch {}
  if (signal.aborted) return '';

  // Detect whether the DELETE endpoints are deployed (non-mutating probe)
  if (deleteSupported === null) {
    deleteSupported = await probeDeleteSupport();
  }

  const cats = tax.categories || [];
  const tags = tax.tags || [];

  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>${t('taxonomy.title')}</h1>
            <p class="page-subtitle">${t('taxonomy.items', { n: cats.length + tags.length })}</p>
          </div>
          <div class="page-header-actions">
            <button class="btn btn-secondary" onclick="addCategory()"><i class="ri-price-tag-3-line"></i> ${t('taxonomy.addCategory')}</button>
            <button class="btn btn-secondary" onclick="addTag()"><i class="ri-hashtag"></i> ${t('taxonomy.addTag')}</button>
          </div>
        </div>

        ${deleteSupported === false ? `<p class="draft-banner" style="background:var(--color-info-soft);color:var(--color-info)"><i class="ri-information-line"></i> Taxonomy delete requires the latest Worker API.</p>` : ''}

        <div class="tax-layout">
          <div class="tax-panel">
            <div class="tax-panel-header">
              <h2><i class="ri-price-tag-3-line"></i> ${t('taxonomy.categories')} <span class="badge badge-neutral">${cats.length}</span></h2>
            </div>
            ${cats.length ? buildCatTree(cats, '') : emptyState('ri-price-tag-3-line', t('taxonomy.emptyCat'))}
          </div>
          <div class="tax-panel">
            <div class="tax-panel-header">
              <h2><i class="ri-hashtag"></i> ${t('taxonomy.tags')} <span class="badge badge-neutral">${tags.length}</span></h2>
            </div>
            ${
              tags.length
                ? `<div class="chips" style="padding:6px 0">${tags
                    .map(
                      (tag) => `
                  <span class="chip">#${escHtml(tag.name)} <span class="chip-count">${tag.count}</span>
                    <button class="icon-btn" style="width:20px;height:20px;font-size:12px" onclick="renameTag('${escHtml(tag.name)}')" title="${t('taxonomy.rename')}" aria-label="${t('taxonomy.rename')}"><i class="ri-edit-line"></i></button>
                    ${deleteSupported ? `<button class="icon-btn" style="width:20px;height:20px;font-size:12px;color:var(--color-danger)" onclick="removeTag('${escHtml(tag.name)}', ${tag.count})" title="${t('taxonomy.delete')}" aria-label="${t('taxonomy.delete')}"><i class="ri-close-line"></i></button>` : ''}
                  </span>`,
                    )
                    .join('')}</div>`
                : emptyState('ri-hashtag', t('taxonomy.emptyTag'))
            }
          </div>
        </div>
      </div>
    `,
  };
}

function buildCatTree(cats, prefix, depth = 0) {
  return cats
    .map((c) => {
      const fullName = prefix ? `${prefix}/${c.name}` : c.name;
      const hasChildren = c.children && c.children.length > 0;
      return `
      <div style="border-bottom:1px solid var(--color-border-light)">
        <div class="tax-row" style="padding-left:${depth * 20}px">
          <span class="tax-row-name">
            ${
              hasChildren
                ? `<i class="ri-arrow-down-s-line cat-toggle" data-cat="${escHtml(fullName)}" onclick="toggleCatChildren(this)" aria-hidden="true"></i>`
                : '<span style="display:inline-block;width:18px"></span>'
            }
            ${escHtml(c.name)}
            <span class="badge badge-neutral">${c.count}</span>
          </span>
          <span class="tax-row-actions">
            <button class="icon-btn" onclick="renameCategory('${escHtml(fullName)}')" title="${t('taxonomy.rename')}" aria-label="${t('taxonomy.rename')}"><i class="ri-edit-line"></i></button>
            ${deleteSupported ? `<button class="icon-btn" style="color:var(--color-danger)" onclick="removeCategory('${escHtml(fullName)}', ${c.count})" title="${t('taxonomy.delete')}" aria-label="${t('taxonomy.delete')}"><i class="ri-delete-bin-line"></i></button>` : ''}
          </span>
        </div>
        ${hasChildren ? `<div class="cat-children" data-cat="${escHtml(fullName)}">${buildCatTree(c.children, fullName, depth + 1)}</div>` : ''}
      </div>`;
    })
    .join('');
}

async function probeDeleteSupport() {
  const API = window.__API_BASE__ || '/api';
  const token = localStorage.getItem('mosaic_admin_token');
  try {
    const resp = await fetch(`${API}/taxonomy/category`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') },
      body: JSON.stringify({ name: '' }),
    });
    return resp.status !== 404;
  } catch {
    return false;
  }
}

window.toggleCatChildren = (icon) => {
  const name = icon.dataset.cat;
  const children = document.querySelector(`.cat-children[data-cat="${CSS.escape(name)}"]`);
  if (children) {
    children.style.display = children.style.display === 'none' ? '' : 'none';
    icon.classList.toggle('ri-arrow-down-s-line');
    icon.classList.toggle('ri-arrow-right-s-line');
  }
};

window.renameCategory = (oldName) => {
  modalInput({
    title: t('common.renameCat'),
    desc: t('common.renameFrom', { old: oldName }),
    value: oldName,
    okLabel: t('common.confirm'),
    validate: (v) => (v ? null : t('taxonomy.nameRequired')),
    onOk: async (newName) => {
      try {
        const r = await taxonomy.renameCategory(oldName, newName);
        toast(t('common.renamed', { old: oldName, new: newName }), 'success');
        window.checkDirty && window.checkDirty();
        if (r.renamed) setTimeout(() => location.reload(), 500);
      } catch (err) {
        toast(t('common.renameFailed') + ': ' + err.message, 'error');
      }
    },
  });
};

window.renameTag = (oldName) => {
  modalInput({
    title: t('common.renameTag'),
    desc: t('common.renameFrom', { old: oldName }),
    value: oldName,
    okLabel: t('common.confirm'),
    validate: (v) => (v ? null : t('taxonomy.nameRequired')),
    onOk: async (newName) => {
      try {
        const r = await taxonomy.renameTag(oldName, newName);
        toast(t('common.renamed', { old: oldName, new: newName }), 'success');
        window.checkDirty && window.checkDirty();
        if (r.renamed) setTimeout(() => location.reload(), 500);
      } catch (err) {
        toast(t('common.renameFailed') + ': ' + err.message, 'error');
      }
    },
  });
};

window.removeCategory = (name, count) => {
  modalConfirm(
    t('taxonomy.deleteCategoryConfirm', { name, count }),
    t('taxonomy.affected', { count }),
    async () => {
      try {
        await taxonomy.removeCategory(name);
        window.checkDirty && window.checkDirty();
        toast(t('taxonomy.deleted'), 'success');
        location.reload();
      } catch (err) {
        toast(t('taxonomy.deleteFailed') + ': ' + err.message, 'error');
      }
    },
    { requireText: count > 0 ? String(count) : null },
  );
};

window.removeTag = (name, count) => {
  modalConfirm(
    t('taxonomy.deleteTagConfirm', { name, count }),
    t('taxonomy.affected', { count }),
    async () => {
      try {
        await taxonomy.removeTag(name);
        window.checkDirty && window.checkDirty();
        toast(t('taxonomy.deleted'), 'success');
        location.reload();
      } catch (err) {
        toast(t('taxonomy.deleteFailed') + ': ' + err.message, 'error');
      }
    },
    { requireText: count > 0 ? String(count) : null },
  );
};

window.addCategory = () => {
  modalInput({
    title: t('taxonomy.addCategory'),
    desc: t('taxonomy.addHintCategory'),
    label: t('taxonomy.newName'),
    placeholder: 'photography/nature',
    okLabel: t('common.confirm'),
    validate: (v) => (v ? null : t('taxonomy.nameRequired')),
    onOk: (name) => {
      location.hash = 'editor&cat=' + encodeURIComponent(name);
    },
  });
};

window.addTag = () => {
  modalInput({
    title: t('taxonomy.addTag'),
    desc: t('taxonomy.addHintTag'),
    label: t('taxonomy.newName'),
    okLabel: t('common.confirm'),
    validate: (v) => (v ? null : t('taxonomy.nameRequired')),
    onOk: (name) => {
      location.hash = 'editor&tags=' + encodeURIComponent(name);
    },
  });
};

export const taxonomySkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:150px;height:30px"></div></div>
    <div class="tax-layout">
      <div class="skeleton-card">${[1, 2, 3, 4].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
      <div class="skeleton-card">${[1, 2, 3, 4].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
    </div>
  </div>
`;
