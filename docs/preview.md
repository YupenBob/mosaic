# 私密预览

预览构建是纯 Serverless 的：Worker 触发 GitHub Actions，Actions 把静态站点写进 R2，Worker 用短时效 token 从 R2 直接返回页面。不创建公开 Pages 域名，也不提前发布文章。

## 流程

1. 编辑器保存云草稿（R2 `drafts/<id>/current.json`）。
2. `POST /api/previews`（管理员会话）创建 `prv_...`，写 `previews/<id>/meta.json`，派发 `preview.yml`。
3. Actions 用一次性 build token 读取草稿，写入内容目录，执行 `npm run build`。
4. Actions 把 `dist/` 上传到 `previews/<id>/`，回调 `/api/preview-build/done`。
5. 编辑器轮询 `/api/previews/<id>`，完成后给出「打开预览」。
6. 浏览器访问 `/api/preview/<access-token>/`；token 默认 24 小时过期。

## 密钥

- `PREVIEW_SECRET`：签名预览访问 token，Worker secret。
- `PIPELINE_SECRET`：签名一次性 build token，Worker 与 Actions 共享。
- `R2_ACCESS_KEY` / `R2_SECRET_KEY` / `R2_ENDPOINT` / `R2_BUCKET`：Actions 上传预览产物。
- `API_TARGET` / `vars.API_TARGET`：Worker 公网地址，用于 Actions 回调。

## 安全

- 预览 token 只存在 URL，`X-Robots-Tag: noindex, nofollow`，`Cache-Control: no-store`。
- 预览对象在 R2 `previews/<id>/`，不会进入生产构建路径。
- build token 1 小时有效，只能读取指定草稿、更新指定预览状态。
- 预览构建不写回 Git，不触发生产部署。

## 限制

- 预览里的绝对链接仍指向生产站点（构建配置未区分预览 URL）；相对资源正常。
- 预览构建不做浏览器回归与离线检查，只执行 `npm run build`。
- 过期预览对象由后续 cleanup 清理；当前不会自动删除。
