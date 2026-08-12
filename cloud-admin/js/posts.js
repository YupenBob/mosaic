/**
 * Posts page — searchable table/cards list with duplicate, open-on-site,
 * per-post stats and chunked rendering.
 */
import { posts as postsApi, stats as statsApi } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=1';
import { escHtml, toast, modalConfirm, modalInput, emptyState, debounce } from './ui.js?v=1';

const CHUNK = 100;
let renderedCount = 0;

export default async function renderPosts(signal) {
  const result = await postsApi.list();
  if (signal.aborted) return '';
  const postsData = result.posts || result || [];
  state.posts = postsData;
  renderedCount = Math.min(CHUNK, postsData.length);

  // Best-effort per-post stats for card view (degrade silently)
  let postStats = {};
  try {
    const r = await statsApi.posts();
    postStats = r.stats || {};
  } catch {}
  state.postStats = postStats;
  if (signal.aborted) return '';

  const catOptions = buildCatOptions(postsData);

  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>${t('posts.title')} <span class="muted">(${postsData.length})</span></h1>
          </div>
          <div class="page-header-actions">
            <div class="view-toggle" role="group" aria-label="View">
              <button class="view-toggle-btn active" data-view="table" onclick="switchPostsView('table')" aria-label="Table view"><i class="ri-list-check"></i></button>
              <button class="view-toggle-btn" data-view="cards" onclick="switchPostsView('cards')" aria-label="Card view"><i class="ri-layout-grid-line"></i></button>
            </div>
            <button class="btn btn-primary" onclick="location.hash='editor'"><i class="ri-add-line"></i> ${t('posts.newPost')}</button>
          </div>
        </div>

        <div class="toolbar-row">
          <div style="position:relative;flex:1;min-width:200px;max-width:340px">
            <i class="ri-search-line" style="position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--color-text-tertiary);font-size:14px"></i>
            <input type="text" id="post-search" class="input" style="padding-left:32px" placeholder="${t('posts.search')}" oninput="debouncedFilterPosts(this.value)" aria-label="${t('posts.search')}" />
          </div>
          <select id="post-cat-filter" class="select" style="width:auto" onchange="filterPostsByCat(this.value)" aria-label="${t('posts.allCats')}">
            <option value="">${t('posts.allCats')}</option>
            ${catOptions}
          </select>
          <span class="search-count" id="post-match-count"></span>
        </div>

        ${
          postsData.length === 0
            ? `<div class="card">${emptyState('ri-article-line', t('posts.emptyTitle'), t('posts.emptyDesc'), `<button class="btn btn-primary" onclick="location.hash='editor'"><i class="ri-add-line"></i> ${t('posts.emptyCta')}</button>`)}</div>`
            : `
          <div id="posts-table-view">
            <div class="table-wrap">
              <table class="data-table" id="posts-table">
                <thead>
                  <tr>
                    <th>${t('posts.tableTitle')}</th>
                    <th>${t('posts.tableCategory')}</th>
                    <th>${t('posts.tableTags')}</th>
                    <th>${t('posts.tableDate')}</th>
                    <th style="text-align:right">${t('common.delete')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${postsData.slice(0, renderedCount).map(rowHtml).join('')}
                </tbody>
              </table>
            </div>
          </div>
          <div id="posts-cards-view" style="display:none">
            <div class="admin-card-grid">
              ${postsData.slice(0, renderedCount).map(cardHtml).join('')}
            </div>
          </div>
          ${
            postsData.length > renderedCount
              ? `<div class="load-more-wrap"><button class="btn btn-secondary" onclick="loadMorePosts()"><i class="ri-arrow-down-line"></i> ${t('common.loadMore')} (${postsData.length - renderedCount})</button></div>`
              : ''
          }
        `
        }
      </div>
    `,
    onMount() {
      const savedView = localStorage.getItem('mosaic_posts_view') || 'table';
      window.switchPostsView(savedView, true);
    },
  };
}

function rowHtml(p) {
  const stats = state.postStats[p.slug] || {};
  return `
    <tr data-search="${escHtml(((p.title || '') + ' ' + (p.category || '') + ' ' + (p.tags || []).join(' ')).toLowerCase())}" data-cat="${escHtml(p.category || '')}">
      <td>
        <span class="cell-main">
          <a href="#editor&slug=${encodeURIComponent(p.slug)}">${escHtml(p.title || p.slug)}</a>
          <span class="cell-sub">${escHtml(p.slug)} · ${stats.views ? `<i class="ri-eye-line"></i> ${stats.views} · <i class="ri-heart-line"></i> ${stats.likes || 0}` : ''}</span>
        </span>
      </td>
      <td>${escHtml(p.category || t('posts.uncategorized'))}</td>
      <td class="muted">${(p.tags || []).map((tag) => '#' + escHtml(tag)).join(' ')}</td>
      <td class="muted" style="white-space:nowrap">${p.date ? String(p.date).split('T')[0] : ''}</td>
      <td>
        <div class="row-actions">
          ${state.siteUrl ? `<a class="icon-btn" href="${escHtml(state.siteUrl)}/posts/${encodeURIComponent(p.slug)}/" target="_blank" rel="noopener" title="${t('posts.openSite')}" aria-label="${t('posts.openSite')}"><i class="ri-external-link-line"></i></a>` : ''}
          <button class="icon-btn" onclick="doDuplicatePost('${escHtml(p.slug)}')" title="${t('common.duplicate')}" aria-label="${t('common.duplicate')}"><i class="ri-file-copy-line"></i></button>
          <a class="icon-btn" href="#editor&slug=${encodeURIComponent(p.slug)}" title="${t('common.edit')}" aria-label="${t('common.edit')}"><i class="ri-edit-line"></i></a>
          <button class="icon-btn" style="color:var(--color-danger)" onclick="doDeletePost('${escHtml(p.slug)}')" title="${t('common.delete')}" aria-label="${t('common.delete')}"><i class="ri-delete-bin-line"></i></button>
        </div>
      </td>
    </tr>
  `;
}

function cardHtml(p) {
  const stats = state.postStats[p.slug] || {};
  const hasCover = p.cover && !String(p.cover).startsWith('video:') && !String(p.cover).startsWith('photo:');
  return `
    <a href="#editor&slug=${encodeURIComponent(p.slug)}" class="admin-post-card"
       data-search="${escHtml(((p.title || '') + ' ' + (p.category || '') + ' ' + (p.tags || []).join(' ')).toLowerCase())}" data-cat="${escHtml(p.category || '')}">
      ${
        hasCover
          ? `<div class="admin-card-cover"><img src="${escHtml(state.mediaBase)}/processed/${encodeURIComponent(p.slug)}/covers/cover-480p.webp" alt="${escHtml(p.title || p.slug)}" loading="lazy" onerror="this.closest('.admin-card-cover').classList.add('admin-card-cover-empty');this.style.display='none'" /></div>`
          : '<div class="admin-card-cover admin-card-cover-empty"><i class="ri-article-line" style="font-size:30px;color:var(--color-text-tertiary)"></i></div>'
      }
      <div class="admin-card-body">
        <span class="admin-card-cat">${escHtml((p.category || t('posts.uncategorized')).split('/').pop())}</span>
        <h3 class="admin-card-title">${escHtml(p.title || p.slug)}</h3>
        ${p.description ? `<p class="admin-card-desc">${escHtml(p.description)}</p>` : ''}
        <div class="admin-card-tags">${(p.tags || [])
          .slice(0, 5)
          .map((tag) => '#' + escHtml(tag))
          .join(' ')}</div>
      </div>
      <div class="admin-card-footer">
        <span>${p.date ? String(p.date).split('T')[0] : ''}</span>
        <span class="admin-card-stats">
          ${stats.views !== undefined ? `<span title="${t('posts.views')}"><i class="ri-eye-line"></i>${stats.views}</span><span title="${t('posts.likes')}"><i class="ri-heart-line"></i>${stats.likes || 0}</span>` : ''}
        </span>
      </div>
    </a>
  `;
}

function buildCatOptions(postsData) {
  const tree = {};
  for (const p of postsData) {
    if (!p.category) continue;
    const parts = String(p.category).split('/');
    let node = tree,
      path = '';
    for (const part of parts) {
      const name = part.trim();
      if (!name) continue;
      path += (path ? '/' : '') + name;
      if (!node[name]) node[name] = { _path: path };
      node = node[name];
    }
  }
  function render(node, depth) {
    return Object.entries(node)
      .filter(([k]) => !k.startsWith('_'))
      .map(([name, info]) => {
        const hasChildren = Object.keys(info).some((k) => !k.startsWith('_'));
        return (
          `<option value="${escHtml(info._path)}">${'&nbsp;&nbsp;'.repeat(depth)}${depth > 0 ? '└ ' : ''}${escHtml(name)}</option>` +
          (hasChildren ? render(info, depth + 1) : '')
        );
      })
      .join('');
  }
  return render(tree, 0);
}

// ── Global actions ─────────────────────────
window.switchPostsView = (view, silent) => {
  const tableEl = document.getElementById('posts-table-view');
  const cardsEl = document.getElementById('posts-cards-view');
  if (tableEl) tableEl.style.display = view === 'cards' ? 'none' : '';
  if (cardsEl) cardsEl.style.display = view === 'cards' ? '' : 'none';
  document.querySelectorAll('.view-toggle-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (!silent) localStorage.setItem('mosaic_posts_view', view);
  const q = document.getElementById('post-search')?.value || '';
  const c = document.getElementById('post-cat-filter')?.value || '';
  if (q) window.filterPosts(q);
  if (c) window.filterPostsByCat(c);
};

window.filterPosts = (query) => {
  const q = query.toLowerCase();
  let count = 0;
  document.querySelectorAll('#posts-table tbody tr, .admin-post-card').forEach((el) => {
    const show = !q || (el.dataset.search || '').includes(q);
    el.style.display = show ? '' : 'none';
    if (show) count++;
  });
  const mc = document.getElementById('post-match-count');
  if (mc) mc.textContent = q ? t('posts.matchCount', { count }) : '';
};

window.filterPostsByCat = (cat) => {
  document.querySelectorAll('#posts-table tbody tr, .admin-post-card').forEach((el) => {
    if (!cat) {
      el.style.display = '';
      return;
    }
    el.style.display = (el.dataset.cat || '') === cat ? '' : 'none';
  });
};

window.debouncedFilterPosts = debounce((v) => window.filterPosts(v), 200);

window.loadMorePosts = () => {
  renderedCount = Math.min(state.posts.length, renderedCount + CHUNK);
  const tableBody = document.querySelector('#posts-table tbody');
  const grid = document.querySelector('#posts-cards-view .admin-card-grid');
  const more = state.posts.slice(renderedCount - CHUNK, renderedCount);
  if (tableBody) tableBody.innerHTML += more.map(rowHtml).join('');
  if (grid) grid.innerHTML += more.map(cardHtml).join('');
  const q = document.getElementById('post-search')?.value || '';
  if (q) window.filterPosts(q);
  const wrap = document.querySelector('.load-more-wrap');
  if (wrap) {
    const remaining = state.posts.length - renderedCount;
    wrap.innerHTML =
      remaining > 0
        ? `<button class="btn btn-secondary" onclick="loadMorePosts()"><i class="ri-arrow-down-line"></i> ${t('common.loadMore')} (${remaining})</button>`
        : '';
  }
};

window.doDeletePost = (slug) => {
  modalConfirm(t('common.deletePost', { slug }), '', async () => {
    try {
      await postsApi.delete(slug);
      window.checkDirty && window.checkDirty();
      location.reload();
    } catch (err) {
      toast(t('common.deleteFailed') + ': ' + err.message, 'error');
    }
  });
};

window.doDuplicatePost = (slug) => {
  modalInput({
    title: t('posts.duplicateTitle'),
    desc: `${slug} →`,
    label: t('posts.duplicateHint'),
    value: slug + '-copy',
    okLabel: t('common.duplicate'),
    onOk: async (newSlug) => {
      try {
        await postsApi.duplicate(slug, newSlug);
        window.checkDirty && window.checkDirty();
        toast(t('common.copied'), 'success');
        location.hash = 'editor&slug=' + encodeURIComponent(newSlug);
      } catch (err) {
        toast(t('common.duplicate') + ': ' + err.message, 'error');
      }
    },
  });
};

export const postsSkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:130px;height:30px"></div></div>
    <div class="skeleton skeleton-line" style="width:320px;height:34px;margin-bottom:12px;border-radius:8px"></div>
    <div class="skeleton-card">${[1, 2, 3, 4, 5].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
  </div>
`;
