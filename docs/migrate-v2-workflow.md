# Media v2 迁移 Workflow

R2/Worker/GitHub 凭据只放在 GitHub Actions，不在本地手工上传或删除媒体。

## 运行

Actions → **Mosaic Media v2 Migration** → Run workflow：

1. `mode=dry-run`：只读取 manifest 和文章，生成 `.mosaic/media-v2-plan.json` 并上传 artifact。
2. 核对计划里的资产数、对象复制数、文章引用数。
3. `mode=apply`，`confirm=media-v2`：复制 R2 对象 → `media/import-v2` → 逐篇重写 frontmatter。
4. 计划文件也会作为 artifact 保留；旧 R2 key 不删除。

## 前置配置

- `API_TARGET`：Worker 公网地址，仓库 Variable。
- `PIPELINE_SECRET`：Worker/Actions 共享 secret。
- `R2_*`：复制对象所需。
- `GITHUB_TOKEN`：workflow 自带，`contents: write`（用于文章 commit）。
- `SITE_BRANCH`：可选，默认 `main`。

## 失败/回滚

- 复制阶段失败：已复制的对象保留，可重跑（目标 key 相同）。
- 导入阶段失败：v2 manifest 可能部分导入；重跑时按资产 ID 覆盖。
- 文章改写失败：逐篇 commit，可用版本历史回滚。
- 不提供“一键清空”；如果迁移确实需要重置，先保留 `media-v2-plan.json` 和 manifest 备份，再单独走清理流程。
