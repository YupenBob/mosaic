/**
 * Posts page — searchable table/cards list with duplicate, open-on-site,
 * per-post stats and chunked rendering.
 */
import { posts as postsApi, stats as statsApi } from '../src/api.js';
import { t } from './i18n.js?v=1';
import { state } from './state.js?v=1';
import { escHtml, toast, modalConfirm, modalInput, emptyState, debounce } from './ui.js?v=1';
import { jsStr } from './escape.js';
import { filterPostList } from './post-filter.js';

const CHUNK = 50;
let renderedCount = 0;

export default async function renderPosts(signal) {
  const statistics = statsApi.posts();
  const result = await postsApi.list();
  if (signal.aborted) return '';
  const postsData = result.posts || result || [];
  state.posts = postsData;
  renderedCount = Math.min(CHUNK, postsData.length);

  // Best-effort per-post stats for card view (degrade silently)
  state.postStats ||= {};
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
          <select id="post-sort" class="select" style="width:auto" onchange="sortPosts(this.value)" aria-label="${t('posts.sortLabel')}">
            <option value="newest">${t('posts.sortNewest')}</option>
            <option value="oldest">${t('posts.sortOldest')}</option>
            <option value="title">${t('posts.sortTitle')}</option>
            <option value="views">${t('posts.sortViews')}</option>
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
          <div class="load-more-wrap" id="posts-load-more">
            ${
              postsData.length > renderedCount
                ? `<button class="btn btn-secondary" onclick="loadMorePosts()"><i class="ri-arrow-down-line"></i> ${t('common.loadMore')} (${postsData.length - renderedCount})</button>`
                : ''
            }
          </div>
          <div id="posts-empty" hidden></div>
        `
        }
      </div>
    `,
    onMount() {
      const savedView = localStorage.getItem('mosaic_posts_view') || 'table';
      window.switchPostsView(savedView, true);
      statistics.then((result) => {
        if (signal.aborted) return;
        state.postStats = result.stats || {};
        window.renderPostsList?.();
      });
    },
  };
}

function coverOf(p) {
  const raw = String(p.cover || '');
  const resolved = String(p.coverResolved || '');
  const literal = raw && !/^(video|photo):/.test(raw) ? raw : '';
  const url =
    resolved ||
    (literal
      ? /^(https?:\/\/|\/)/.test(literal)
        ? literal
        : '/api/media/file/' + encodeURIComponent(p.slug) + '/' + encodeURIComponent(literal)
      : '');
  const srcset = p.coverSrcset?.['480'] || p.coverSrcset?.[480] || '';
  return { src: srcset || url, lqip: p.coverLqip || '', has: !!(srcset || url) };
}

function thumbHtml(p) {
  const cover = coverOf(p);
  return cover.has
    ? `<span class="cell-thumb"><i class="ri-article-line" aria-hidden="true"></i><img src="${escHtml(cover.src)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" /></span>`
    : `<span class="cell-thumb" aria-hidden="true"><i class="ri-article-line"></i></span>`;
}

function rowHtml(p) {
  const stats = state.postStats[p.slug] || {};
  return `
    <tr data-search="${escHtml(((p.title || '') + ' ' + (p.category || '') + ' ' + (p.tags || []).join(' ')).toLowerCase())}" data-cat="${escHtml(p.category || '')}">
      <td>
        <span class="cell-post">
          ${thumbHtml(p)}
          <span class="cell-main">
            <a href="#editor&slug=${encodeURIComponent(p.slug)}">${escHtml(p.title || p.slug)}</a>
            <span class="cell-sub">${escHtml(p.slug)} · ${stats.views ? `<i class="ri-eye-line"></i> ${stats.views} · <i class="ri-heart-line"></i> ${stats.likes || 0}` : ''}</span>
          </span>
        </span>
      </td>
      <td>${escHtml(p.category || t('posts.uncategorized'))}</td>
      <td class="muted">${(p.tags || []).map((tag) => '#' + escHtml(tag)).join(' ')}</td>
      <td class="muted" style="white-space:nowrap">${p.date ? String(p.date).split('T')[0] : ''}</td>
      <td>
        <div class="row-actions">
          ${state.siteUrl ? `<a class="icon-btn" href="${escHtml(state.siteUrl)}/posts/${encodeURIComponent(p.slug)}/" target="_blank" rel="noopener" title="${t('posts.openSite')}" aria-label="${t('posts.openSite')}"><i class="ri-external-link-line"></i></a>` : ''}
          <button class="icon-btn" onclick="doDuplicatePost(${jsStr(p.slug)})" title="${t('common.duplicate')}" aria-label="${t('common.duplicate')}"><i class="ri-file-copy-line"></i></button>
          <a class="icon-btn" href="#editor&slug=${encodeURIComponent(p.slug)}" title="${t('common.edit')}" aria-label="${t('common.edit')}"><i class="ri-edit-line"></i></a>
          <button class="icon-btn" style="color:var(--color-danger)" onclick="doDeletePost(${jsStr(p.slug)})" title="${t('common.delete')}" aria-label="${t('common.delete')}"><i class="ri-delete-bin-line"></i></button>
        </div>
      </td>
    </tr>
  `;
}

function cardHtml(p) {
  const stats = state.postStats[p.slug] || {};
  const cover = coverOf(p);
  return `
    <a href="#editor&slug=${encodeURIComponent(p.slug)}" class="admin-post-card"
       data-search="${escHtml(((p.title || '') + ' ' + (p.category || '') + ' ' + (p.tags || []).join(' ')).toLowerCase())}" data-cat="${escHtml(p.category || '')}">
      ${
        cover.has
          ? `<div class="admin-card-cover"${cover.lqip ? ` style="background-image:url('${escHtml(cover.lqip)}')"` : ''}><i class="ri-article-line admin-card-cover-fallback" aria-hidden="true"></i><img src="${escHtml(cover.src)}" alt="${escHtml(p.title || p.slug)}" loading="lazy" decoding="async" onerror="this.remove()" /></div>`
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
  window.filterPosts(q);
  if (c) window.filterPostsByCat(c);
};

function filteredPosts() {
  return filterPostList(state.posts, {
    query: document.getElementById('post-search')?.value || '',
    category: document.getElementById('post-cat-filter')?.value || '',
    sort: document.getElementById('post-sort')?.value || 'newest',
    stats: state.postStats,
  });
}

function renderPostsList({ reset = true } = {}) {
  const tableBody = document.querySelector('#posts-table tbody');
  const grid = document.querySelector('#posts-cards-view .admin-card-grid');
  if (!tableBody || !grid) return;
  const list = filteredPosts();
  if (reset) renderedCount = Math.min(CHUNK, list.length);
  const visible = list.slice(0, renderedCount);
  tableBody.innerHTML = visible.map(rowHtml).join('');
  grid.innerHTML = visible.map(cardHtml).join('');

  const q = document.getElementById('post-search')?.value || '';
  const cat = document.getElementById('post-cat-filter')?.value || '';
  const count = document.getElementById('post-match-count');
  if (count) count.textContent = q || cat ? t('posts.matchCount', { count: list.length }) : '';

  const empty = document.getElementById('posts-empty');
  const tableView = document.getElementById('posts-table-view');
  const cardsView = document.getElementById('posts-cards-view');
  const loadMore = document.getElementById('posts-load-more');
  if (empty) {
    if (!list.length) {
      empty.hidden = false;
      empty.innerHTML = emptyState(
        'ri-search-line',
        t('posts.noMatchTitle'),
        t('posts.noMatchDesc'),
        `<button class="btn btn-secondary" onclick="clearPostFilters()"><i class="ri-close-line"></i> ${t('posts.clearFilters')}</button>`,
      );
      if (tableView) tableView.hidden = true;
      if (cardsView) cardsView.hidden = true;
    } else {
      empty.hidden = true;
      empty.innerHTML = '';
      if (tableView) tableView.hidden = false;
      if (cardsView) cardsView.hidden = false;
    }
  }
  if (loadMore) {
    const remaining = list.length - renderedCount;
    loadMore.innerHTML =
      remaining > 0
        ? `<button class="btn btn-secondary" onclick="loadMorePosts()"><i class="ri-arrow-down-line"></i> ${t('common.loadMore')} (${remaining})</button>`
        : '';
  }
}

window.renderPostsList = renderPostsList;
window.filterPosts = () => renderPostsList();
window.filterPostsByCat = () => renderPostsList();
window.sortPosts = () => renderPostsList();
window.clearPostFilters = () => {
  const search = document.getElementById('post-search');
  const cat = document.getElementById('post-cat-filter');
  if (search) search.value = '';
  if (cat) cat.value = '';
  renderPostsList();
};
window.debouncedFilterPosts = debounce(() => renderPostsList(), 200);

window.loadMorePosts = () => {
  const list = filteredPosts();
  renderedCount = Math.min(list.length, renderedCount + CHUNK);
  renderPostsList({ reset: false });
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
