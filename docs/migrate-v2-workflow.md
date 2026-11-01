# Media v2 迁移 Workflow

R2/Worker/GitHub 凭据只放在 GitHub Actions，不在本地手工上传或删除媒体。

## 运行

Actions → **Mosaic Media v2 Migration** → Run workflow：

1. `mode=dry-run`：只读取 manifest 和文章，生成 `.mosaic/media-v2-plan.json` 并上传 artifact。
2. 核对计划里的资产数、对象复制数、文章引用数、**将重写的文章文件数**。
3. `mode=apply`，`confirm=media-v2`：在 `production` 环境运行 → `npm run check` 通过 → 复制 R2 对象（已存在的目标键跳过）→ `media/import-v2` → **一次 commit 重写全部 `content/posts/*/index.md`** → 触发站点构建。

实现要点：

- 文章改写走 GitHub Git Data API（`scripts/lib/github-git-data.mjs`，blob → tree → commit → ref），不再逐篇 `PUT /contents`；上百篇文章也只有一次 commit、一次 CI 触发。
- commit message 含 `[skip ci]`，避免迁移 commit 触发 pipeline；随后单独 dispatch 站点构建，ref 使用 `SITE_BRANCH`。
- 冲突即失败：commit 的 parent 是开始迁移前捕获的分支 head，`expectedBaseSha` 不匹配或 ref 非快进更新时迁移停止，不会覆盖并发提交。
- 重跑安全：R2 目标键已存在则跳过；文章 frontmatter 已与计划一致则不进 commit。

## 前置配置

- `API_TARGET`：Worker 公网地址，仓库 Variable。
- `PIPELINE_SECRET`：Worker/Actions 共享 secret。
- `R2_*`：复制对象所需。
- `GITHUB_TOKEN`：workflow 自带，`contents: write`（Git Data API commit）。
- `SITE_BRANCH`：可选，默认 `main`；同时决定 commit 分支与构建 dispatch 的 ref。

## 失败/回滚

- 复制阶段失败：已复制的对象保留，可重跑（目标 key 相同；已存在目标直接跳过）。
- 导入阶段失败：v2 manifest 可能部分导入；重跑时按资产 ID 覆盖。
- commit 阶段失败（base 移动/ref 拒绝）：迁移在写 commit 前停止，旧的 R2 copy/import 已完成且幂等，重新运行即可。
- 文章改写是单 commit，可直接 revert 该 commit 回滚。
- 不提供“一键清空”；如果迁移确实需要重置，先保留 `media-v2-plan.json` 和 manifest 备份，再单独走清理流程。
- 迁移 commit 不自动触发站点构建以外的流程；媒体域安全与上线检查见 [security-media.md](security-media.md)。
