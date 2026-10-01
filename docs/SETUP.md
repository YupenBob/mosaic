# 从零搭建

## 本地开发

使用 Node 22 或更高版本，版本入口为 `.nvmrc`。纯站点开发不需要 FFmpeg、R2 或生产密码。

```bash
npm ci
npm ci --prefix worker
npm run check
npm run lint
npm run format:check
npm run build
npm run serve
```

需要已有媒体时把版本化清单快照保存为 `.mosaic/media-manifest.json`，或设置 MEDIA_MANIFEST_FILE。站点只读取这个快照，不扫描原文件或 checksum 缓存。没有媒体快照时仍可构建文本文章。

```bash
npx playwright install chromium webkit
npm run test:e2e:local
npm run test:admin:local
```

媒体集成测试用本地 FFmpeg 与合成样本，运行 `npm run test:media`，不上传任何对象。Worker 本地开发在 `worker/` 执行 `npm run dev`；默认离线检查不自动加载 `.dev.vars`。

## Cloudflare 与 GitHub

1. 建立 R2 桶、媒体自定义域名，配置跨域 GET/HEAD、上传 PUT 和 ETag expose。
2. 建立静态站点与云后台两个 Pages 项目；在配置中填 url、mediaBase、apiBase、deployment 项目与 allowedOrigins。
3. 准备 Worker 的 ADMIN_PASSWORD、JWT_SECRET、GITHUB_TOKEN、R2_ACCESS_KEY、R2_SECRET_KEY、CF_ACCOUNT_ID（或 R2_ENDPOINT）、PIPELINE_SECRET。GitHub Token 需要内容读写及 Actions 调度权限；保留 IP 代理 PROXY_SECRET。
4. 在 Actions 设置同一 PIPELINE_SECRET，以及 R2/Cloudflare Secrets。所有命名与 Variables 见 [configuration.md](configuration.md) 与 `.env.example`。
5. 先部署 Mosaic Infrastructure，保留 STATS 数据并创建独立 JOBS。Pages API_TARGET 由配置脚本输出；两端 PROXY_SECRET 一致。
6. 首次启用运行 Mosaic Media，完成旧数据核验或空清单初始化，再运行 Mosaic Site。已有站点必须按 [migration.md](migration.md) 的顺序切换。

以后保存纯内容只构建站点；上传自动处理并更新站点。视频低档先就绪，高档自动补齐。后台构建中心区分媒体处理与部署进度。
