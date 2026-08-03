/**
 * Build page — summary cards, pipeline progress, current run status with
 * failure diagnosis, history, dynamic polling and completion notifications.
 */
import { build } from '../src/api.js';
import { t } from './i18n.js';
import { escHtml, formatTime, fmtDuration, getStatusDef, statusBadge, toast, copyText } from './ui.js';

// Chinese labels for the known pipeline steps (GitHub returns English names)
const STEP_LABELS_ZH = {
  'Checkout': '检出代码',
  'Setup Node': '安装 Node.js',
  'Install tools': '安装工具（ffmpeg / rclone / exiftool）',
  'Install deps': '安装依赖',
  'Restore media checksums cache': '恢复媒体校验缓存',
  'Sync media from R2': '同步 R2 原始媒体',
  'Strip EXIF from originals': '剥离原图 EXIF（隐私）',
  'Compress media': '压缩媒体（图片 / 视频 / 音频）',
  'Save media checksums cache': '保存媒体校验缓存',
  'Generate site': '生成站点',
  'Run tests': '运行测试',
  'Upload to R2': '上传处理产物到 R2',
  'Upload video media': '上传视频 HLS 流',
  'Sync stripped originals back': '回传剥离 EXIF 的原图',
  'Strip media from dist': '从构建产物移除媒体',
  'Copy Functions to dist': '复制代理函数到产物',
  'Deploy to Cloudflare Pages': '部署到 Cloudflare Pages',
};

function stepLabel(name) {
  return localStorage.getItem('mosaic_admin_lang') === 'en' ? name : (STEP_LABELS_ZH[name] || name);
}

let stepsDetailOpen = false;

export default async function renderBuild(signal) {
  let statusData = null, historyData = { runs: [] };
  try {
    [statusData, historyData] = await Promise.all([
      build.status().catch(() => null),
      build.history().catch(() => ({ runs: [] })),
    ]);
  } catch {}
  if (signal.aborted) return '';

  const runs = historyData.runs || [];
  const latest = statusData && statusData.status !== 'unknown' ? statusData : runs[0] || null;
  const summary = buildSummary(runs, latest);
  const repoUrl = latest?.repo || runs[0]?.repo || '';
  const initialRunning = !!(latest && (latest.status === 'in_progress' || latest.status === 'queued'));
  stepsDetailOpen = initialRunning;

  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>${t('build.title')}</h1>
            <p class="page-subtitle">${runs.length ? t('build.runsCount', { n: runs.length }) : ''}</p>
          </div>
          <div class="page-header-actions">
            <button class="btn btn-secondary" onclick="location.reload()"><i class="ri-refresh-line"></i> ${t('build.refresh')}</button>
            <button class="btn btn-primary" data-build-trigger onclick="window.doTriggerBuild()"><i class="ri-play-fill"></i> ${t('build.trigger')}</button>
          </div>
        </div>

        <div class="build-summary">
          <div class="dash-big-card build-summary-card"><span class="dash-big-num">${summary.successRate}</span><span class="dash-big-label">${t('build.successRate')}</span></div>
          <div class="dash-big-card build-summary-card"><span class="dash-big-num">${summary.avgDur}</span><span class="dash-big-label">${t('build.avgDuration')}</span></div>
          <div class="dash-big-card build-summary-card"><span class="dash-big-num mono" style="font-size:20px">${escHtml(summary.branch || '—')}</span><span class="dash-big-label">${t('build.currentBranch')}</span></div>
        </div>

        <div id="build-status-card">${latest ? renderStatusCard(latest) : renderEmptyState()}</div>
        ${runs.length > 0 ? `
          <div id="build-history">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <h2 style="margin:0">${t('build.history')}</h2>
              ${repoUrl ? `<a href="${escHtml(repoUrl)}/actions/workflows/pipeline.yml" target="_blank" rel="noopener" style="font-size:13px;color:var(--color-accent);text-decoration:none">${t('build.viewAll')} <i class="ri-external-link-line"></i></a>` : ''}
            </div>
            ${renderRunHistory(runs)}
          </div>` : ''}
      </div>
    `,
    onMount() {
      window.setBuildTriggerStates && window.setBuildTriggerStates(initialRunning);
      let durTicker, pollTimer;
      let lastPollAt = Date.now();
      let prevStatus = latest ? latest.status : null;
      let stopped = false;

      const tickDur = () => {
        const el = document.getElementById('build-duration');
        if (el && el.dataset.start) {
          const sec = Math.floor((Date.now() - new Date(el.dataset.start).getTime()) / 1000);
          if (el.dataset.status === 'in_progress' || el.dataset.status === 'queued') {
            el.textContent = t('build.durationRunning') + ' ' + fmtDuration(sec);
          }
        }
        const stepEl = document.getElementById('step-elapsed');
        if (stepEl && stepEl.dataset.start) {
          const sec = Math.floor((Date.now() - new Date(stepEl.dataset.start).getTime()) / 1000);
          stepEl.textContent = t('build.elapsedShort', { t: fmtDuration(sec) });
        }
        const upd = document.getElementById('build-updated');
        if (upd) upd.textContent = t('build.updatedAgo', { s: Math.max(1, Math.round((Date.now() - lastPollAt) / 1000)) });
      };
      durTicker = setInterval(tickDur, 1000);

      const schedule = (ms) => { if (!stopped) pollTimer = setTimeout(poll, ms); };

      const updateLive = async () => {
        const live = document.getElementById('build-live-progress');
        if (!live) return;
        const pr = await build.progress().catch(() => null);
        if (pr && pr.stage && pr.updatedAt && Date.now() - new Date(pr.updatedAt).getTime() < 180000) {
          live.classList.remove('hidden');
          live.innerHTML = `<i class="ri-loader-4-line spin"></i> ${progressText(pr)}`;
        } else {
          live.classList.add('hidden');
        }
      };

      async function poll() {
        try {
          const s = await build.status();
          lastPollAt = Date.now();
          const running = !!(s && (s.status === 'in_progress' || s.status === 'queued'));
          window.setBuildTriggerStates && window.setBuildTriggerStates(running);
          const card = document.getElementById('build-status-card');
          if (card && s && s.status !== 'unknown') {
            const wasRunning = prevStatus === 'in_progress' || prevStatus === 'queued';
            card.innerHTML = renderStatusCard(s);
            if (wasRunning && !running) {
              if (s.conclusion === 'success') {
                toast(t('build.terminalSuccess', { n: s.runNumber }), 'success', 6000);
                document.title = t('build.terminalSuccess', { n: s.runNumber }) + ' — Mosaic Cloud Admin';
              } else if (s.conclusion === 'failure') {
                toast(t('build.terminalFailed', { n: s.runNumber }), 'error', 9000);
                document.title = t('build.terminalFailed', { n: s.runNumber }) + ' — Mosaic Cloud Admin';
              }
            }
            prevStatus = s.status;
          }
          if (running) {
            await updateLive();
            schedule(s.status === 'queued' ? 10000 : 5000);
          } else {
            clearTimeout(pollTimer);
            const h = await build.history().catch(() => ({ runs: [] }));
            const histEl = document.getElementById('build-history');
            if (histEl) {
              const r = h.runs || [];
              histEl.innerHTML = r.length
                ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">${t('build.history')}</h2></div>${renderRunHistory(r)}`
                : '';
            }
          }
        } catch {
          schedule(10000);
        }
      }

      if (initialRunning) schedule(5000);
      if (initialRunning) updateLive();

      const onVis = () => {
        if (document.hidden) {
          clearTimeout(pollTimer);
          clearInterval(durTicker);
        } else {
          lastPollAt = Date.now();
          durTicker = setInterval(tickDur, 1000);
          if (!stopped) poll();
        }
      };
      document.addEventListener('visibilitychange', onVis);
      const cleanup = () => {
        stopped = true;
        clearTimeout(pollTimer);
        clearInterval(durTicker);
        document.removeEventListener('visibilitychange', onVis);
        window.setBuildTriggerStates && window.setBuildTriggerStates(false);
      };
      window.addEventListener('hashchange', cleanup, { once: true });
    },
  };
}

function buildSummary(runs, latest) {
  const terminal = runs.filter((r) => r.conclusion === 'success' || r.conclusion === 'failure').slice(0, 10);
  const ok = terminal.filter((r) => r.conclusion === 'success').length;
  const successRate = terminal.length ? Math.round((ok / terminal.length) * 100) + '%' : '—';
  const durations = runs
    .filter((r) => r.createdAt && r.updatedAt)
    .map((r) => new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime())
    .filter((d) => d > 0);
  const avgSec = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : null;
  return {
    successRate,
    avgDur: avgSec ? fmtDuration(avgSec) : '—',
    branch: latest?.headBranch || runs[0]?.headBranch || '',
  };
}

function buildDuration(run) {
  if (!run.createdAt) return '';
  const start = new Date(run.createdAt).getTime();
  const end = run.status === 'in_progress' || run.status === 'queued'
    ? Date.now()
    : (run.updatedAt ? new Date(run.updatedAt).getTime() : Date.now());
  return fmtDuration(Math.floor((end - start) / 1000));
}

function progressText(pr) {
  if (pr.stage === 'media' && pr.current) {
    return `${t('build.stages.media')}：${escHtml(pr.current)}${pr.total ? `（${pr.done || 0}/${pr.total}）` : ''}`;
  }
  return escHtml(pr.message || t('build.stages.' + pr.stage) || pr.stage);
}

function renderPipeline(run) {
  const steps = run.steps || [];
  if (!steps.length) {
    return `<div class="build-pipeline"><span class="muted">${t('build.noSteps')}</span></div>`;
  }
  const now = Date.now();
  const done = steps.filter((s) => s.status === 'completed' && s.conclusion === 'success').length;
  const failed = steps.find((s) => s.conclusion === 'failure');
  const runningStep = steps.find((s) => s.status === 'in_progress');
  const running = run.status === 'in_progress' || run.status === 'queued';

  // Duration-weighted segments: real elapsed time per step, so the bar
  // reflects remaining work instead of equal-width steps.
  const completedDurs = steps
    .filter((s) => s.status === 'completed' && s.startedAt && s.completedAt)
    .map((s) => new Date(s.completedAt) - new Date(s.startedAt));
  const avgCompleted = completedDurs.length ? completedDurs.reduce((a, b) => a + b, 0) / completedDurs.length : 10000;
  const stepDur = (s) => {
    if (s.status === 'completed') {
      return s.startedAt && s.completedAt ? Math.max(1000, new Date(s.completedAt) - new Date(s.startedAt)) : avgCompleted;
    }
    if (s.status === 'in_progress') {
      return s.startedAt ? Math.max(1000, now - new Date(s.startedAt)) : avgCompleted;
    }
    return avgCompleted; // queued
  };
  const weights = steps.map(stepDur);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const doneWeight = steps.reduce((a, s, i) => {
    if (s.status === 'completed' || s.status === 'in_progress') return a + weights[i];
    return a;
  }, 0);
  const percent = totalWeight > 0 ? Math.max(0, Math.min(100, Math.round((doneWeight / totalWeight) * 100))) : 0;

  let label;
  if (failed) {
    label = `<span style="color:var(--color-danger)"><i class="ri-close-circle-line"></i> ${t('build.stepFailed', { n: failed.number, name: failed.name })}</span>`;
  } else if (runningStep) {
    label = `${t('build.stage')}：${escHtml(stepLabel(runningStep.name))} · ${t('build.stepsDone', { done, total: steps.length })}`;
  } else if (run.status === 'completed') {
    label = `${t('build.allCompleted')} · ${t('build.stepsDone', { done, total: steps.length })}`;
  } else {
    label = t('build.stepsDone', { done, total: steps.length });
  }
  const segs = steps.map((s, i) => {
    let cls = 'pending';
    if (s.status === 'completed' && s.conclusion === 'success') cls = 'done';
    else if (s.status === 'completed' && s.conclusion === 'failure') cls = 'failed';
    else if (s.status === 'in_progress') cls = 'active';
    else if (s.status === 'completed') cls = 'skipped';
    // flex-grow weights the segment by its real duration; gaps share the
    // remaining space so the bar never overflows its container.
    const g = weights[i] || 1;
    return `<span class="pipeline-seg ${cls}" style="flex-grow:${g.toFixed(1)}" title="${escHtml(stepLabel(s.name))} (#${s.number}) · ${fmtDuration(Math.round(weights[i] / 1000))}"></span>`;
  }).join('');

  // ETA: rate-based estimate from elapsed time + progress ratio
  let etaText = '';
  if (running && percent >= 5 && percent < 100 && doneWeight > 0) {
    const start = run.createdAt ? new Date(run.createdAt).getTime() : now;
    const elapsedSec = Math.max(0, now - start) / 1000;
    const ratio = doneWeight / totalWeight;
    const etaSec = Math.round(elapsedSec * (1 / ratio - 1));
    if (etaSec > 0) etaText = t('build.eta', { t: fmtDuration(etaSec) });
  }

  const detailRows = steps.map((s) => {
    let cls, statusLabel;
    if (s.status === 'completed') {
      if (s.conclusion === 'success') { cls = 'ok'; statusLabel = t('build.stepSuccess'); }
      else if (s.conclusion === 'failure') { cls = 'bad'; statusLabel = t('build.stepFailedShort'); }
      else if (s.conclusion === 'skipped') { cls = 'muted'; statusLabel = t('build.stepSkipped'); }
      else if (s.conclusion === 'cancelled') { cls = 'muted'; statusLabel = t('build.stepCancelled'); }
      else { cls = 'muted'; statusLabel = s.conclusion || s.status; }
    } else if (s.status === 'in_progress') {
      cls = 'busy'; statusLabel = t('build.stepRunning');
    } else {
      cls = 'muted'; statusLabel = t('build.stepQueued');
    }
    let d = '';
    if (s.status === 'completed' && s.startedAt && s.completedAt) {
      d = fmtDuration(Math.round((new Date(s.completedAt) - new Date(s.startedAt)) / 1000));
    } else if (s.status === 'in_progress' && s.startedAt) {
      d = `<span id="step-elapsed" data-start="${s.startedAt}">${t('build.elapsedShort', { t: fmtDuration(Math.max(0, Math.round((now - new Date(s.startedAt)) / 1000))) })}</span>`;
    }
    return `
      <div class="build-step-row">
        <span class="step-num">#${s.number}</span>
        <span class="step-dot ${cls}"></span>
        <span class="step-name">${escHtml(stepLabel(s.name))}</span>
        <span class="step-status ${cls}">${escHtml(statusLabel)}</span>
        ${d ? `<span class="step-dur">${d}</span>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="build-pipeline">
      <div class="pipeline-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">${segs}</div>
      <div class="pipeline-meta">
        <span class="pipeline-label">${label}</span>
        <span class="pipeline-percent">${percent}%</span>
      </div>
      ${etaText ? `<div class="pipeline-eta"><i class="ri-time-line"></i> ${etaText}</div>` : ''}
      ${running ? `<div class="build-live-progress hidden" id="build-live-progress"></div>` : ''}
      <div class="pipeline-detail-toggle">
        <button class="btn btn-ghost btn-sm" onclick="toggleBuildSteps()"><i class="ri-list-check-2"></i> ${t('build.stepsDetail')}</button>
      </div>
      <div class="build-steps-detail ${stepsDetailOpen ? '' : 'hidden'}" id="build-steps-detail">${detailRows}</div>
    </div>
  `;
}

window.toggleBuildSteps = () => {
  const el = document.getElementById('build-steps-detail');
  if (!el) return;
  stepsDetailOpen = !stepsDetailOpen;
  el.classList.toggle('hidden', !stepsDetailOpen);
};

function renderStatusCard(run) {
  const def = getStatusDef(run.status, run.conclusion);
  const time = formatTime(run.createdAt);
  const dur = buildDuration(run);
  const durLabel = (run.status === 'in_progress' || run.status === 'queued') ? t('build.durationRunning') : t('build.durationDone');
  return `
    <div class="card build-status-card">
      <div class="build-status-head">
        <span class="status-dot ${def.dot}" style="width:12px;height:12px"></span>
        <span class="build-run-no">#${run.runNumber || '—'}${run.displayTitle ? ' — ' + escHtml(run.displayTitle) : ''}</span>
        ${statusBadge(def)}
        ${dur ? `<span class="build-duration" id="build-duration" data-start="${run.createdAt}" data-status="${run.status}">${durLabel} ${dur}</span>` : ''}
        <span class="build-duration" id="build-updated" style="margin-left:auto"></span>
      </div>

      ${renderPipeline(run)}

      ${run.failedStep ? `
        <div class="build-failed-step">
          <i class="ri-close-circle-line"></i>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(run.failedStep.name)}</span>
          ${run.failedStep.logUrl ? `<a class="btn btn-danger btn-sm" href="${escHtml(run.failedStep.logUrl)}" target="_blank" rel="noopener"><i class="ri-terminal-line"></i> ${t('build.viewLog')}</a>` : ''}
        </div>` : ''}

      <div class="build-meta">
        <div><span class="build-meta-label">${t('build.branch')}</span><code>${escHtml(run.headBranch || 'main')}</code></div>
        <div>
          <span class="build-meta-label">${t('build.commit')}</span>
          <span style="display:inline-flex;gap:4px;align-items:center">
            ${run.commitUrl
              ? `<a href="${escHtml(run.commitUrl)}" target="_blank" rel="noopener" class="mono" style="font-size:12px;color:var(--color-text-primary);text-decoration:none" title="${escHtml(run.headShaFull || run.headSha)}">${escHtml(run.headSha || '—')}</a>`
              : `<code>${escHtml(run.headSha || '—')}</code>`}
            ${run.headSha ? `<button class="btn btn-ghost btn-sm" onclick="window.copySha('${escHtml(run.headSha)}')" title="${t('build.copySha')}" aria-label="${t('build.copySha')}"><i class="ri-file-copy-line"></i></button>` : ''}
          </span>
        </div>
        <div><span class="build-meta-label">${t('build.event')}</span>${escHtml(run.event || 'push')}</div>
        <div><span class="build-meta-label">${t('build.time')}</span>${time}</div>
      </div>
      ${run.commitMessage ? `<div class="build-commit-msg">${escHtml(run.commitMessage)} <button class="btn btn-ghost btn-sm" data-msg="${escHtml(run.commitMessage)}" onclick="window.copyCommitFrom(this)" title="${t('build.copyCommit')}" aria-label="${t('build.copyCommit')}"><i class="ri-file-copy-line"></i></button></div>` : ''}
      ${run.htmlUrl ? `<a href="${run.htmlUrl}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:5px;margin-top:14px;font-size:13px;color:var(--color-accent);text-decoration:none">${t('build.viewOnGitHub')} <i class="ri-external-link-line"></i></a>` : ''}
    </div>
  `;
}

function renderRunHistory(runs) {
  return `
    <div style="display:flex;flex-direction:column;gap:2px">
      ${runs.map((r) => {
        const s = getStatusDef(r.status, r.conclusion);
        const time = formatTime(r.createdAt);
        const dur = buildDuration(r);
        return `
          <div class="build-history-row">
            <span class="build-history-run">#${r.runNumber}</span>
            ${statusBadge(s)}
            <span class="build-history-title">${escHtml(r.displayTitle || r.commitMessage || '')}</span>
            ${dur ? `<span class="muted" style="min-width:64px;text-align:right">${dur}</span>` : ''}
            ${r.commitUrl
              ? `<a href="${escHtml(r.commitUrl)}" target="_blank" rel="noopener" class="build-history-meta" title="${escHtml(r.headShaFull || r.headSha)}">${escHtml(r.headSha || '')}</a>`
              : `<span class="build-history-meta">${escHtml(r.headSha || '')}</span>`}
            <span class="build-history-time">${time}</span>
            ${r.htmlUrl ? `<a href="${r.htmlUrl}" target="_blank" rel="noopener" class="btn btn-sm" style="text-decoration:none">${t('build.viewOnGitHub')} <i class="ri-external-link-line"></i></a>` : ''}
          </div>`;
      }).join('')}
    </div>
  `;
}

function renderEmptyState() {
  return `
    <div style="text-align:center;padding:52px 24px;background:var(--color-surface);border:2px dashed var(--color-border);border-radius:var(--radius-lg);margin-bottom:20px">
      <i class="ri-tools-line" style="font-size:46px;color:var(--color-text-tertiary)"></i>
      <h2 style="margin:12px 0 4px;font-size:var(--font-size-lg)">${t('build.noBuild')}</h2>
      <p style="color:var(--color-text-secondary);margin-bottom:16px;font-size:var(--font-size-sm)">${t('build.noBuildHint')}</p>
      <button class="btn btn-primary" data-build-trigger onclick="window.doTriggerBuild()"><i class="ri-play-fill"></i> ${t('build.trigger')}</button>
    </div>
  `;
}

window.copySha = (sha) => copyText(sha);
window.copyCommitFrom = (btn) => copyText(btn.dataset.msg || '');

export const buildSkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:150px;height:30px"></div></div>
    <div class="build-summary">${[1, 2, 3].map(() => '<div class="skeleton-card"><div class="skeleton skeleton-big-num"></div><div class="skeleton skeleton-big-label"></div></div>').join('')}</div>
    <div class="skeleton-card"><div class="skeleton skeleton-line w40" style="height:18px;margin-bottom:12px"></div>${['branch', 'commit', 'event', 'time'].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
    <div class="skeleton-card">${[1, 2, 3].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
  </div>
`;
