# Mosaic 运维与性能

## 构建性能

### 缓存机制

- 媒体 checksum 缓存：`dist/.media-checksums.json`，由 GitHub Actions `actions/cache` 存/取
- v2 起缓存内包含**产物清单**（每视频档位、封面/照片宽高比），因此缓存命中时 `compress` 秒级跳过，`generate` 仍能正确输出 HLS 与封面
- 构建期间 checksums 会逐档镜像到 R2 `site-data/media-checksums.json`：构建被取消/超时时，下一次构建从最后完成的档位**续传**，而不是整段视频重转
- 缓存命中（内容未变）构建约 **3 分钟**；媒体变更时视转码量 10–20 分钟

### 何时会全量重建

- checksum 文件版本升级（如 v1→v2 的首次引导）
- 新增/修改/删除媒体文件
- 缓存被 GitHub 清理（7 天无访问或超 10GB）

### 构建超时与视频转码

- `build.timeoutMinutes`（设置 → 构建）控制单次构建超时，默认 90 分钟（范围 10–360）。后台触发的构建经 `workflow_dispatch` input 传入该值（管线内 `fromJSON` 转整数，字符串会导致 job 无法启动）；push 自动构建无 inputs，固定 90 分钟
- 视频按档位**升序**（240p→4K）转码并**边转边传**：`videoQuality.uploadAfterTiers`（默认 1 = 每档即传）控制每完成 n 档上传一批（该档 mp4/m3u8/ts 随档即传，poster/master 最后上传）
- **时间预算保护**：已用时长达到超时值的 85%（默认 90 分钟 → 约 76 分钟）后跳过剩余高档位，用已完成档位生成 master 并继续构建部署；缺失档位由下一次构建续传补齐（续传前对 R2 做 HEAD 校验，缺失即补转）
- 最终 `worker/scripts/upload-videos.mjs` 为 **reconcile**：对每个本地文件先 HEAD，R2 已存在即跳过、缺失才上传（幂等兜底）

### 加速建议

- 视频转码档位受 `videoQuality.maxHeight` 控制：默认 1080p，调低（720p）可显著缩短转码
- `videoQuality.preset` 调快（如 `ultrafast`）进一步减少耗时，体积略增
- 视频上传已并入转码流程（随档上传），无需单独等待；reconcile 步骤只补缺失对象

## 媒体分发

### 直连 vs 代理

- 图片/封面：`<img>` 不需要 CORS，直连 `mosaic-media.xsanye.cn`
- HLS：hls.js 跨域 XHR 需要 CORS。当前媒体域 **Transform Rule 尚未配置**，视频对象保持 `Cache-Control: no-store`（上传器默认，pipeline 不覆盖），保证直连响应始终带 ACAO；配置 Transform Rule 强制 `Access-Control-Allow-Origin: *` 后，再把 `VIDEO_CACHE_CONTROL` 设为 `public, max-age=31536000` 恢复边缘缓存

### CORS 排查

- 浏览器控制台出现 CORS 报错：检查桶级 CORS（`worker/r2-cors.json`）与 Transform Rule
- 确认请求带 `Origin`（浏览器自动带）；无 Origin 的请求不返回 CORS 头属正常

## Worker 运维

### 部署与 Secrets

```bash
cd worker
npx wrangler deploy
npx wrangler secret list            # 查看已配置
npx wrangler secret put <NAME>      # 设置：ADMIN_PASSWORD/JWT_SECRET/GITHUB_TOKEN/CF_ACCOUNT_ID/R2_ACCESS_KEY/R2_SECRET_KEY/PROXY_SECRET
```

### 健康端点与日志

- `/api/health`、`/api/health/github`、`/api/health/r2`
- 实时日志：`npx wrangler tail`

### 统计（Durable Object）

- 视图/点赞/停留时长由 `StatsDurableObject` 串行写入，单实例保证不丢更新
- 首次访问自动从 R2 `site-data/stats.json` 迁移历史；此后 DO 为主、stats.json 备份
- 若需重置统计：清空 DO 存储需谨慎，备份 stats.json 后可重建

### 上传

- 预签名直传：浏览器 → R2，单文件最大 5GB，1 小时有效期
- Worker 直传兜底：≤100MB（平台请求体上限）
- 访客 IP 信任：Pages 代理用 `PROXY_SECRET` 对 `IP:分钟桶` 做 HMAC-SHA256 签名（请求头 `X-Mosaic-Proxy-IP / X-Mosaic-Proxy-Time / X-Mosaic-Proxy-Sig`），Worker 校验签名（±2 分钟窗口），失败回退 `CF-Connecting-IP`；旧静态头方案（`X-Mosaic-Proxy` + `X-Real-IP`）兼容一个发布周期后移除。两份代理文件由 `node scripts/sync-proxy.mjs` 从 `shared/pages-proxy.mjs` 同步，勿手改 `functions/api/[[path]].js` 与 `cloud-admin/functions/api/[[path]].js`
- 管理端点 CORS 白名单：`ALLOWED_ORIGINS`（逗号分隔，默认 `https://mosaic-admin.xsanye.cn`）；`/api/health*`、`/api/stats/*`、`/api/track/*`、`/api/media/*` 保持 `*` 开放
- 登录限流（5 次/5 分钟）与浏览去重（10 分钟/IP）为 per-isolate 内存实现，多隔离部署下属 best-effort，不保证全局精确
- R2 用量统计：`site-data/media-usage.json` 快照在每次上传/删除时增量更新；`/api/disk` 优先读快照（24h 内），缺失或过期时全量并行遍历并回写；批量清理（删除文章、cleanup delete、processed-cache）会使快照失效触发重建

## 生产巡检

- `health-check.yml` 每 6 小时运行 `check-site.mjs`，失败即 GitHub 告警
- 可手动触发：GitHub → Actions → Production Health Check → Run workflow

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 登录 503 | `JWT_SECRET` 或 `ADMIN_PASSWORD` 未配置（fail-closed） |
| 登录 429 | 触发限流，等待 5 分钟 |
| 视频无法播放 | 媒体域 CORS / Transform Rule；`PROXY_SECRET` 一致性 |
| 构建慢 | 检查缓存是否命中（见上）；媒体变更属正常 |
| 上传失败 | 大文件走预签名（>100MB 直传会 413）；确认 Worker R2 凭证 |
| 统计不涨 | 浏览器是否带 `Origin`（正常请求都带）；DO 冷启动迁移日志 |

## 升级与回滚

- 代码：`git pull` → 推 `main` 触发构建；回滚用 `git revert`
- Worker：`npx wrangler rollback`
- Pages：Dashboard → Deployments → 选择历史版本
- 详见 [migration.md](migration.md)
