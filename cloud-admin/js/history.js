/**
 * Git history: commits are the version store. Restore writes a new commit, so
 * history itself is never rewritten.
 */
import { history as historyApi } from '../src/api.js';
import { escHtml, toast, emptyState, formatTime, openModal, modalConfirm } from './ui.js?v=1';

function commitRow(commit) {
  return `<button type="button" class="history-row" data-sha="${escHtml(commit.sha)}">
    <span class="history-main"><strong>${escHtml(commit.message || '(no message)')}</strong><span>${escHtml(commit.author || '')} · ${escHtml(commit.shortSha || '')}</span></span>
    <time>${escHtml(commit.date ? formatTime(commit.date) : '')}</time>
  </button>`;
}

async function openCommit(sha) {
  let commit;
  try {
    commit = await historyApi.get(sha);
  } catch (error) {
    toast('读取提交失败：' + (error.message || ''), 'error');
    return;
  }
  const content = `
    <div class="history-detail">
      <p class="field-hint">${escHtml(commit.author || '')} · ${escHtml(commit.date ? formatTime(commit.date) : '')} · ${escHtml(commit.sha)}</p>
      <div class="history-files">
        ${(commit.files || [])
          .map(
            (file) => `<details class="history-file">
              <summary><span class="badge ${file.status === 'removed' ? 'badge-danger' : 'badge-neutral'}">${escHtml(file.status)}</span> ${escHtml(file.filename)} <span class="field-hint">+${file.additions} / -${file.deletions}</span></summary>
              ${file.binary ? '<p class="field-hint">二进制文件，不显示 diff。</p>' : `<pre>${escHtml(file.patch || '(no patch)')}</pre>`}
              <button type="button" class="btn btn-ghost btn-sm" data-restore-file="${escHtml(file.filename)}">恢复这个文件</button>
            </details>`,
          )
          .join('')}
      </div>
    </div>`;
  const overlay = openModal({
    title: commit.message || '提交',
    content,
    wide: true,
    actions: [
      { label: '关闭', className: 'btn-secondary' },
      {
        label: '恢复整次提交',
        className: 'btn-danger',
        closeOnClick: false,
        onClick: () => applyRestore(commit, ''),
      },
    ],
  });
  overlay?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-restore-file]');
    if (!button) return;
    await applyRestore(commit, button.dataset.restoreFile);
  });
}

async function applyRestore(commit, path) {
  const label = path || '整次提交';
  modalConfirm('恢复版本？', `将根据 ${commit.shortSha} 恢复${label}。这会创建新的提交，不会改写历史。`, async () => {
    try {
      const result = await historyApi.restore(commit.sha, path);
      if (result.ok) {
        toast('已恢复；去「上线」构建后生效', 'success', 7000);
        location.reload();
      } else {
        toast('部分文件恢复失败，请查看详情', 'error');
      }
    } catch (error) {
      toast('恢复失败：' + (error.message || ''), 'error');
    }
  });
}

export default async function renderHistory(signal) {
  let commits = [];
  let failed = false;
  try {
    const result = await historyApi.list(40);
    commits = result.commits || [];
  } catch {
    failed = true;
  }
  if (signal.aborted) return '';
  return {
    html: `
      <div class="page-anim">
        <div class="page-header">
          <div>
            <h1>版本历史</h1>
            <p class="page-subtitle">文章、配置和主题的 Git 提交；恢复会创建新提交，不删除历史。</p>
          </div>
        </div>
        <div class="card">
          ${
            failed
              ? '<div class="page-load-error card-pad" role="alert">历史加载失败。检查 Worker 的 GitHub 权限。</div>'
              : commits.length
                ? `<div class="history-list">${commits.map(commitRow).join('')}</div>`
                : emptyState('ri-git-commit-line', '还没有提交', '第一次保存后会出现在这里。')
          }
        </div>
      </div>
    `,
    onMount() {
      document.querySelector('.history-list')?.addEventListener('click', (event) => {
        const row = event.target.closest('[data-sha]');
        if (row) openCommit(row.dataset.sha);
      });
    },
  };
}

export const historySkeleton = () => `
  <div class="page-anim">
    <div class="page-header"><div class="skeleton skeleton-line" style="width:140px;height:30px"></div></div>
    <div class="skeleton-card">${[1, 2, 3, 4].map(() => '<div class="skeleton skeleton-line"></div>').join('')}</div>
  </div>
`;
