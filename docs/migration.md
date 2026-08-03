# Mosaic 版本升级与迁移指南

本文面向**已在使用旧版本的用户**，说明如何升级到当前版本（v1.0）。全新部署请直接看 [SETUP.md](SETUP.md)。

## v0.8 → v1.0 概览

主要变化：

- 管理后台重构为 ES Module 零构建 SPA（v0.9），本地 Express 后台（`admin/`）已移除
- 统计改为 Durable Object（视图/点赞/停留时长），历史 `site-data/stats.json` 自动迁移
- 媒体上传改为预签名直传（浏览器 → R2），Worker 直传仅作 ≤100MB 兜底
- 构建引入媒体 checksum 缓存 + 产物清单：内容未变时压缩秒级跳过
- 新增：构建进度上报、批量文章统计、分类/标签删除、文章分页、回收站、生产健康检查
- 新增环境变量：`PROXY_SECRET`（IP 透传）、`DEV_MODE`（本地开发）、`VIDEO_CACHE_CONTROL`（CI 缓存头）

## 升级步骤

### 1. 拉取最新代码

```bash
git pull origin main
npm install
```

`mosaic.config.json` 无需手工迁移：缺少的键由代码默认值兜底，Admin 后台保存配置为深合并，不会丢字段。

### 2. 配置 Secrets

按 [SETUP.md](SETUP.md) 第 4.2 / 6.1 节设置：

- Worker Secrets：`ADMIN_PASSWORD`、`JWT_SECRET`、`GITHUB_TOKEN`、`CF_ACCOUNT_ID`、`R2_ACCESS_KEY`、`R2_SECRET_KEY`、`PROXY_SECRET`
- 两个 Pages 项目 Secret：`PROXY_SECRET`（与 Worker 一致）
- GitHub Actions Secrets：`R2_ACCESS_KEY`、`R2_SECRET_KEY`、`R2_ENDPOINT`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`

### 3. 部署

```bash
cd worker && npx wrangler deploy
cd .. && npx wrangler pages deploy cloud-admin --project-name mosaic-admin
```

### 4. 媒体清单缓存首次引导

压缩脚本的 checksum 文件已升级到 v2（新增产物清单）。首次构建会自动触发一次全量重建并写入清单，之后增量生效——首次构建会比平时慢，属预期。

### 5. 统计迁移

旧统计在 R2 `site-data/stats.json`。首次访问统计接口时，Durable Object 会自动读取并迁移该文件，无需手工操作；此后以 DO 存储为主、stats.json 仅作备份。

### 6. 移除本地后台

`admin/`（本地 Express 后台）已从仓库移除，请改用云后台 `cloud-admin`（部署于 `mosaic-admin.xsanye.cn`）。

### 7. 媒体域 CORS（推荐）

按 [SETUP.md](SETUP.md) 6.2 节添加 Transform Rule，以保证 HLS 跨域播放稳定；配置后可把 `VIDEO_CACHE_CONTROL` 设为 `public, max-age=31536000` 恢复视频边缘缓存。

## 验证清单

- [ ] `/api/health` 返回 ok
- [ ] Admin 登录成功，仪表盘显示正确文章/分类/标签统计
- [ ] 上传一张图片 + 一个视频，构建后前台正常展示（HLS 可播放）
- [ ] 页面浏览量在重复访问后递增（DO 统计生效）
- [ ] `node tests/check-site.mjs` 通过

## 回滚

- 代码回滚：`git revert <commit>` 后推送到 `main` 触发重建
- Worker：`npx wrangler rollback`
- Pages：Cloudflare Dashboard → Pages → Deployments 选择历史版本

## 常见问题

- **构建比预期慢**：媒体变更或首次 v2 引导属正常；内容未变仍慢请检查 checksum 缓存是否恢复（见 [operations.md](operations.md)）
- **视频无法播放**：确认媒体域 CORS（桶级或 Transform Rule）与 `PROXY_SECRET` 配置一致
- **登录 503**：`JWT_SECRET` 未配置，Worker fail-closed（见 [operations.md](operations.md)）
