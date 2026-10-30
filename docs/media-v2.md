# Media v2：独立素材与迁移

## 目标

素材（asset）是独立对象，不再挂在文章 slug 下。文章只保存素材 ID 引用；同一素材可被多篇文章使用，可先上传后写作。

## 身份与路径

- 资产 ID：`ast_` + 26 位小写 base32；迁移使用旧 ID 的 SHA-256 派生，保证幂等。
- 原文件：`originals/assets/<assetId>/<filename>`
- 产物：`processed/assets/<assetId>/<generation>/...`
- 旧路径 `originals/<slug>/...`、`processed/<slug>/...` 在迁移期保留，不主动删除。

## Manifest

`site-data/media-manifest.json` 可以是混合 schema：

```json
{ "schemaVersion": 2, "revision": 12, "assets": { "ast_...": { "v2": true, "...": "..." } } }
```

- v1 条目仍以 `slug/folder/filename` 为 key。
- v2 条目必须 `v2: true`，`id` 与 key 一致。
- `validateManifest` 同时接受两者；v2 完整校验见 `shared/media-v2.mjs`。

## 文章引用

```yaml
media:
  gallery: [ast_...]
  videos: [ast_...]
  music: [ast_...]
  cover: ast_...
```

正文仍写 `{{photo:N}}` / `{{video:N}}` / `{{gallery}}` / `{{videos}}` / `{{music}}`；`N` 是数组下标。没有 `media` 的旧文章按 `asset.legacy.slug` 回退。

## 上传

1. `POST /api/assets` → 预签名 URL + `assetId`。
2. 浏览器直接 PUT 到 R2。
3. `POST /api/assets/:id/complete` → HEAD 校验 + Jobs DO 入队。
4. 大文件使用 `/api/assets/:id/multipart/*`。
5. 处理完成后 `assets-list` 返回 `published/lifecycle`；`/api/assets/:id/preview` 提供缩略图。

## 生命周期

`lifecycle.state`：`processing / ready / degraded / failed / deleting / deleted`。

- `degraded`：仍可用，但源文件已删或最新任务失败。
- `DELETE /api/assets/:id` 默认软删除 7 天，`POST /api/assets/:id/restore` 恢复。
- 实际对象清理由后续 cleanup 任务按 `purgeAfter` 执行。

## 迁移

```bash
# 只读计划（需要 R2 / Worker 凭据）
node scripts/media/migrate-v2.mjs --write-plan

# 执行：复制对象 → 导入 v2 manifest → 重写文章 frontmatter
MIGRATION_CONFIRM=media-v2 node scripts/media/migrate-v2.mjs --apply
```

- CLI 必须在 GitHub Actions 或具备 R2/GitHub 凭据的环境运行。
- `--apply` 只复制、不删除旧对象；旧 key 至少保留 30 天。
- 文章改写是逐篇 Git 提交，可用 Git 历史逐篇回滚。
- 迁移前备份 `site-data/media-manifest.json` 与文章提交。

## 回滚

1. 回滚文章 frontmatter 提交。
2. 恢复旧 manifest（`site-data/media-manifest.v1.json`）。
3. 旧 R2 key 仍在；v2 对象可保留供排查。
4. 若已切换部署，回滚到迁移前构建。
