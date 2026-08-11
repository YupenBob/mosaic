/**
 * Dashboard page — health bar, stat cards, charts, leaderboard, activity.
 */
import { posts as postsApi, stats, health, disk, config, build, taxonomy } from '../src/api.js';
import { t } from './i18n.js';
import { state } from './state.js';
import { escHtml, formatTime, quick, loadLib, emptyState } from './ui.js';

const CHART_URL = 'js/vendor/chart.umd.min.js';

export default async function renderDashboard(signal) {
  const [dashData, healthData, trafficData, healthGithub, healthR2, diskData, cfg, taxData] = await Promise.all([
    quick(() => stats.dashboard(), { posts: '...', categories: '...', tags: '...' }),
    quick(() => health.check(), { status: 'error' }),
    quick(() => stats.traffic(), { total: '...', byDay: [], byCategory: [], byTag: [], top5: [] }, 20000),
    quick(() => health.github(), { status: 'error' }),
    quick(() => health.r2(), { status: 'error' }),
    quick(() => disk.usage(), { sizeMB: '...', objects: '...', cost: '...' }),
    quick(() => config.get(), {}),
    quick(() => taxonomy.get(), { categories: [], tags: [] }),
  ]);
  if (signal.aborted) return '';

  if (cfg.mediaBase) state.mediaBase = cfg.mediaBase;
  state.config = cfg;
  state.siteUrl = cfg.url || '';
  const today = new Date().toISOString().slice(0, 10);
  const todayViews = (trafficData.byDay || []).find((d) => d.date === today)?.count || 0;
  const weekViews = (trafficData.byDay || []).slice(-7).reduce((s, d) => s + d.count, 0);

  // Recent activity
  const activities = [];
  const postResult = await quick(() => postsApi.list(), { posts: [] }, 20000);
  const postList = postResult.posts || postResult || [];
  postList.slice(0, 5).forEach((p) => {
    if (p.date)
      activities.push({
        icon: 'ri-article-line',
        text: escHtml(p.title || p.slug) + ' ' + t('dashboard.updated'),
        time: p.date,
      });
  });
  try {
    const bs = await quick(() => build.status().catch(() => null), null, 5000);
    if (bs && bs.createdAt) {
      activities.push({
        icon: 'ri-tools-line',
        text: 'Build #' + (bs.runNumber || '?') + ' ' + (bs.conclusion || bs.status),
        time: bs.createdAt,
      });
    }
  } catch {}
  activities.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

  const healthItems = [
    {
      name: t('dashboard.healthWorker'),
      status: healthData.status === 'ok' ? 'ok' : 'down',
      latency: healthData.latency,
    },
    {
      name: t('dashboard.healthGithub'),
      status: healthGithub.status === 'ok' ? 'ok' : 'down',
      latency: healthGithub.latency,
    },
    { name: t('dashboard.healthR2'), status: healthR2.status === 'ok' ? 'ok' : 'down', latency: healthR2.latency },
    { name: t('dashboard.healthPages'), status: healthData.status === 'ok' ? 'ok' : 'down' },
  ];
  const allHealthy = healthItems.every((h) => h.status === 'ok');

  const quickstart =
    (!postList.length && dashData.posts !== '...') || dashData.posts === 0
      ? `
      <div class="card card-pad mb-4">
        <h3 style="margin-bottom:12px"><i class="ri-rocket-line" style="color:var(--color-accent)"></i> ${t('dashboard.quickTitle')}</h3>
        <div class="quickstart-card">
          <div class="quickstart-step">
            <span class="quickstart-num">1</span>
            <div><h4>${t('dashboard.q1Title')}</h4><p>${t('dashboard.q1Desc')}</p></div>
          </div>
          <div class="quickstart-step">
            <span class="quickstart-num">2</span>
            <div><h4>${t('dashboard.q2Title')}</h4><p>${t('dashboard.q2Desc')}</p></div>
          </div>
          <div class="quickstart-step">
            <span class="quickstart-num">3</span>
            <div><h4>${t('dashboard.q3Title')}</h4><p>${t('dashboard.q3Desc')}</p></div>
          </div>
        </div>
      </div>
    `
      : '';

  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>${t('dashboard.title')}</h1>
            <p class="page-subtitle">${allHealthy ? t('dashboard.healthy') : t('dashboard.issues')}</p>
          </div>
          <div class="page-header-actions">
            <button class="btn btn-secondary btn-sm" onclick="location.reload()"><i class="ri-refresh-line"></i> ${t('dashboard.refresh')}</button>
            <button class="btn btn-primary" onclick="location.hash='editor'"><i class="ri-add-line"></i> ${t('dashboard.newPost')}</button>
            <button class="btn btn-secondary" data-build-trigger onclick="window.doTriggerBuild()"><i class="ri-play-fill"></i> ${t('dashboard.buildDeploy')}</button>
            ${state.siteUrl ? `<a href="${escHtml(state.siteUrl)}" target="_blank" rel="noopener" class="btn btn-secondary"><i class="ri-external-link-line"></i> ${t('dashboard.viewSite')}</a>` : ''}
          </div>
        </div>

        <div class="dash-health-bar" role="status" aria-label="Health">
          ${healthItems
            .map(
              (h) => `
            <div class="dash-health-item">
              <span class="dash-health-dot ${h.status === 'ok' ? 'healthy' : 'down'}"></span>
              <span class="dash-health-name">${h.name}</span>
              <span class="dash-health-info">${h.status === 'ok' ? t('common.ok') + (h.latency != null ? ` · ${h.latency}ms` : '') : '—'}</span>
            </div>`,
            )
            .join('')}
        </div>

        <div class="dash-cards">
          <div class="dash-big-card"><span class="dash-big-num">${dashData.posts ?? '...'}</span><span class="dash-big-label">${t('dashboard.posts')}</span></div>
          <div class="dash-big-card"><span class="dash-big-num">${dashData.categories ?? '...'}</span><span class="dash-big-label">${t('dashboard.categories')}</span></div>
          <div class="dash-big-card"><span class="dash-big-num">${dashData.tags ?? '...'}</span><span class="dash-big-label">${t('dashboard.tags')}</span></div>
          <div class="dash-big-card"><span class="dash-big-num">${trafficData.total ?? '...'}</span><span class="dash-big-label">${t('dashboard.totalViews')}</span></div>
          <div class="dash-big-card"><span class="dash-big-num">${todayViews}</span><span class="dash-big-label">${t('dashboard.todayViews')} · ${weekViews}${t('dashboard.weekSuffix')}</span></div>
          <div class="dash-big-card"><span class="dash-big-num">${diskData.sizeMB ?? '...'} MB</span><span class="dash-big-label">${t('dashboard.r2Usage')} · ${t('dashboard.r2Meta', { objects: diskData.objects ?? '...', cost: diskData.cost ?? '...' })}</span></div>
        </div>

        ${quickstart}

        <div class="dash-charts">
          <div class="dash-chart-card">
            <h3><span>${t('dashboard.traffic')}</span><button class="btn btn-ghost btn-sm" onclick="location.reload()"><i class="ri-refresh-line"></i></button></h3>
            <div class="dash-chart-wrap"><canvas id="chart-traffic"></canvas></div>
          </div>
          <div class="dash-chart-card">
            <h3>${t('dashboard.catTag')}</h3>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div class="dash-chart-wrap" style="height:200px"><canvas id="chart-categories"></canvas></div>
              <div class="dash-chart-wrap" style="height:200px"><canvas id="chart-tags"></canvas></div>
            </div>
          </div>
        </div>

        <div class="dash-bottom">
          <div class="dash-chart-card">
            <h3>${t('dashboard.leaderboard')}</h3>
            ${
              (trafficData.top5 || []).length
                ? trafficData.top5
                    .map(
                      (item, i) => `
                <a href="#editor&slug=${encodeURIComponent(item.slug)}" class="dash-top-item">
                  <span class="dash-top-rank" style="color:${['var(--color-warning)', 'var(--color-text-tertiary)', '#cd7f32', 'var(--color-text-tertiary)', 'var(--color-text-tertiary)'][i] || 'var(--color-text-tertiary)'}">#${i + 1}</span>
                  <span class="dash-top-slug">${escHtml(item.title || item.slug)}</span>
                  <span class="dash-top-count">${item.count} ${t('dashboard.viewsShort')}</span>
                </a>`,
                    )
                    .join('')
                : emptyState('ri-bar-chart-line', t('dashboard.noData'), t('dashboard.noTraffic'))
            }
          </div>
          <div class="dash-chart-card">
            <h3>${t('dashboard.recentActivity')}</h3>
            ${
              activities.length
                ? activities
                    .slice(0, 8)
                    .map(
                      (a) => `
                <div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--color-border-light);font-size:13px">
                  <i class="${a.icon}" style="color:var(--color-text-tertiary);font-size:14px"></i>
                  <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.text}</span>
                  <span style="color:var(--color-text-tertiary);font-size:11px;flex-shrink:0">${formatTime(a.time)}</span>
                </div>`,
                    )
                    .join('')
                : emptyState('ri-time-line', t('dashboard.noActivity'))
            }
          </div>
        </div>
      </div>
    `,
    async onMount() {
      // Lazy-load Chart.js only when the dashboard is actually shown
      try {
        await loadLib(CHART_URL);
      } catch {
        return;
      }
      if (signal.aborted) return;
      const dayLabels = (trafficData.byDay || []).map((d) => d.date.slice(5));
      const dayData = (trafficData.byDay || []).map((d) => d.count);
      // "分类 & 标签" reflects the real site taxonomy (article counts),
      // not the traffic view distribution (stats.json has no category data).
      const catList = (taxData.categories || [])
        .slice()
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
      const tagList = (taxData.tags || [])
        .slice()
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
      const catLabels = catList.map((c) => c.name);
      const catData = catList.map((c) => c.count);
      const tagLabels = tagList.map((tt) => tt.name);
      const tagData = tagList.map((tt) => tt.count);
      const palette = [
        'var(--chart-1)',
        'var(--chart-2)',
        'var(--chart-3)',
        'var(--chart-4)',
        'var(--chart-5)',
        'var(--chart-6)',
        'var(--chart-7)',
        'var(--chart-8)',
        'var(--chart-9)',
        'var(--chart-10)',
      ];
      const noData = (id) => {
        const el = document.getElementById(id);
        if (el && el.parentElement) {
          el.parentElement.innerHTML = `<div style="text-align:center;padding:36px;color:var(--color-text-tertiary)"><i class="ri-bar-chart-line" style="font-size:30px"></i><p style="margin-top:8px;font-size:13px">${t('dashboard.noData')}</p></div>`;
        }
      };
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--chart-1').trim() || '#4361ee';
      if (dayData.some((v) => v > 0)) makeChart('chart-traffic', 'line', dayLabels, dayData, accent);
      else noData('chart-traffic');
      if (catData.some((v) => v > 0)) makeChart('chart-categories', 'doughnut', catLabels, catData, palette);
      else noData('chart-categories');
      if (tagLabels.length && tagData.some((v) => v > 0))
        makeChart('chart-tags', 'doughnut', tagLabels, tagData, palette);
      else noData('chart-tags');
    },
  };
}

function makeChart(id, type, labels, data, colors) {
  const canvas = document.getElementById(id);
  if (!canvas || !window.Chart || !labels.length) return;
  const resolve = (c) =>
    c && c.startsWith('var(')
      ? getComputedStyle(document.documentElement).getPropertyValue(c.slice(4, -1)).trim() || '#4361ee'
      : c;
  new window.Chart(canvas, {
    type,
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: Array.isArray(colors) ? colors.map(resolve) : resolve(colors) + '33',
          borderColor: Array.isArray(colors) ? colors.map(resolve) : resolve(colors),
          borderWidth: type === 'line' ? 2 : 1,
          fill: type === 'line',
          tension: 0.3,
          pointRadius: type === 'line' ? 2 : 0,
          pointHoverRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend:
          type === 'doughnut'
            ? {
                display: true,
                position: 'right',
                labels: {
                  boxWidth: 10,
                  font: { size: 11 },
                  color:
                    getComputedStyle(document.documentElement).getPropertyValue('--color-text-secondary').trim() ||
                    '#86868b',
                },
              }
            : { display: false },
      },
      scales:
        type !== 'doughnut'
          ? {
              x: {
                display: type === 'bar',
                grid: { color: 'transparent' },
                ticks: {
                  color: getComputedStyle(document.documentElement).getPropertyValue('--color-text-tertiary').trim(),
                },
              },
              y: {
                beginAtZero: true,
                ticks: {
                  precision: 0,
                  color: getComputedStyle(document.documentElement).getPropertyValue('--color-text-tertiary').trim(),
                },
                grid: { color: 'rgba(128,128,128,0.1)' },
              },
            }
          : {},
    },
  });
}

export const dashboardSkeleton = () => `
  <div class="page-anim">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <div class="skeleton skeleton-line" style="width:110px;height:30px;margin:0"></div>
      <div class="skeleton skeleton-line" style="width:220px;height:34px;margin:0"></div>
    </div>
    <div class="dash-health-bar"><div class="skeleton" style="height:44px;width:100%"></div></div>
    <div class="dash-cards">
      ${[1, 2, 3, 4, 5, 6].map(() => '<div class="skeleton-card"><div class="skeleton skeleton-big-num"></div><div class="skeleton skeleton-big-label"></div></div>').join('')}
    </div>
    <div class="dash-charts">
      <div class="skeleton-card"><div class="skeleton skeleton-line w40" style="height:18px"></div><div class="skeleton skeleton-chart"></div></div>
      <div class="skeleton-card"><div class="skeleton skeleton-line w40" style="height:18px"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div class="skeleton skeleton-chart"></div><div class="skeleton skeleton-chart"></div></div></div>
    </div>
    <div class="dash-bottom">
      <div class="skeleton-card">${[1, 2, 3].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
      <div class="skeleton-card">${[1, 2, 3].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
    </div>
  </div>
`;
