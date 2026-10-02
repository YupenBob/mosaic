# 配置指南

`mosaic.config.json` 为站点配置，`shared/config.mjs` 为 Node 与 Worker 共用的默认值、兼容映射和校验。合并对象、替换数组；禁止原型键。Secret 不写入配置文件。

## 主要配置

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `deployment.branch` | main | 内容、工作流和部署分支 |
| `deployment.siteWorkflow` / `mediaWorkflow` | pipeline.yml / media.yml | 两类 workflow_dispatch |
| `deployment.siteProject` / `adminProject` / `workerName` | mosaic / mosaic-admin / mosaic-api | 部署目标 |
| `deployment.allowedOrigins` | 空数组 | 后台跨域白名单 |
| `mediaSource.bucket` / `endpoint` | mosaic-media / 空 | R2 桶与 S3 endpoint |
| `mediaBase` / `apiBase` | 空 / /api | 媒体公共地址与 API 地址；生产需配置媒体域 |
| `build.timeoutMinutes` | 90 | 站点调度超时 |
| `media.timeoutMinutes` | 90 | 独立媒体调度超时 |
| `media.budgetRatio` | 0.85 | 提前保存断点的时间预算 |
| `media.maxRetries` | 3 | 首次失败后最多自动重试次数 |
| `media.debounceMs` / `retryMs` | 10000 / 30000 | 合并调度与重试间隔 |
| `media.leaseMs` / `pollMs` | 120000 / 30000 | 心跳租约与调度检查 |
| `media.retentionDays` | 30 | 未引用产物清理前保留时间 |
| `media.deploymentHistory` / `reconcileBatchSize` | 20 / 25 | 保留部署记录数与配置补处理批大小 |
| `media.cacheControl` | public, max-age=86400 | 版本化媒体缓存策略 |
| `media.manifestKey` | site-data/media-manifest.json | 当前媒体清单入口 |
| `media.image.placeholderWidth` / `placeholderQuality` | 150 / 30 | 占位 WebP 参数 |
| `media.audio.bitrates` / `waveformBuckets` / `sampleRate` | [128k,320k] / 400 / 8000 | MP3 与波形参数 |
| `imageQuality` | 480p:75,720p:80,1080p:85 | 图片档位质量，实际传给 Sharp |
| `videoQuality.crf` / `preset` / `maxHeight` | 23 / veryfast / 1080 | 实际 FFmpeg 编码参数 |
| `videoQuality.uploadAfterTiers` | 1 | 验证后分批发布视频档位 |
| `videoQuality.fps` / `segmentSeconds` / `audioBitrate` | 30 / 6 / 128k | 视频帧率、HLS 分片、AAC 码率 |
| `upload.concurrency` / `partConcurrency` / `partRetries` | 3 / 3 / 3 | 浏览器上传调度 |
| `upload.multipartThreshold` / `partSize` | 100 MiB / 100 MiB | 分片阈值与片大小 |
| `upload.presignSeconds` / `maxFileBytes` | 3600 / 5 GiB | 签名时效与文件上限 |
| `cache.postsMs` / `configMs` | 60000 / 120000 | Worker 列表与配置缓存 |
| `cache.diskMs` / `usageMaxAgeMs` | 300000 / 86400000 | 用量缓存与快照最长有效时间 |
| `admin.dirtyPollMs` / `jobPollMs` | 60000 / 5000 | 后台轮询 |
| `admin.idlePollMs` / `hiddenPollMs` | 30000 / 60000 | 无活动构建与隐藏标签页的轮询间隔 |
| `admin.requestTimeoutMs` | 15000 | API 读取、保存与上传确认的等待上限；不限制文件传输 |
| `admin.cacheMs` / `buildCacheMs` | 15000 / 3000 | 浏览器共享读取缓存；写入或换账号后失效 |
| `player.requestVersion` | cors-v1 | 稳定播放请求命名空间，绕开旧无 Origin 的浏览器缓存；设空字符串关闭 |
| `player.defaultAspect` | 16/9 | 缺失媒体比例时预留的视频尺寸 |
| `player.speeds` / `qualityOrder` / `hls` | 见共享默认值 | 倍速、菜单次序、HLS 缓冲和重试参数 |
| `search.debounceMs` / `maxResults` / `searchMinChars` | 250 / 10 / 2 | 搜索交互 |

图片压缩由 `plugins.compress-images.enabled` 控制，关闭时仍生成隐私处理后的原图与占位图。视频压缩由 `plugins.compress-videos.enabled` 控制，关闭时使用源编码封装并移除元数据，仍提供 HLS/MP4；不兼容 MP4 的源编码会报告任务错误。原 `enableVideoCompression` 保留兼容映射，显式 plugin 设置优先。组件 enabled、画廊 zoom/lazyLoad 及搜索开关会传给前台运行时。

没有显式 `media.timeoutMinutes` 时沿用旧 `build.timeoutMinutes`。处理指纹只包含对应处理器参数；改标题、缓存或部署域名不会使所有文件重新转码。

HLS 默认 `autoStartLoad:false`、`startFragPrefetch:false`，点击播放才开始分片下载；`manifestLoadingTimeOut` 默认 10000ms。播放请求命名空间不是随机时间戳，同一版本仍可缓存。变更这些播放或后台策略不会触发转码。

## 环境与 Secrets

Node 脚本仅读取显式环境，不自动加载 `.env` 或 `worker/.dev.vars`。默认检查不访问生产凭据。Worker 本地开发由 Wrangler 加载 `.dev.vars`。

- Worker Secrets：`ADMIN_PASSWORD`、`JWT_SECRET`、`GITHUB_TOKEN`、`R2_ACCESS_KEY`、`R2_SECRET_KEY`、`CF_ACCOUNT_ID`（或 `R2_ENDPOINT`）、`PIPELINE_SECRET`；保留已有 `PROXY_SECRET`。
- Actions Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`R2_ACCESS_KEY`、`R2_SECRET_KEY`、`R2_ENDPOINT`、`PIPELINE_SECRET`。
- Actions Variables：`API_TARGET`、`SITE_BRANCH`、`R2_BUCKET`、`ALLOWED_ORIGINS`、`MOSAIC_RUNNER`、`SITE_TIMEOUT_MINUTES`、`MEDIA_TIMEOUT_MINUTES`。未设目标时部署脚本从配置输出域名、分支、项目、桶；push 超时与 runner 必须由 Actions Variables 或工作流默认提供，因为 checkout 前无法读取配置。
- Pages：站点与后台都设置 `API_TARGET`；IP 签名仍使用两端相同的 `PROXY_SECRET`。基础设施工作流只 PATCH `API_TARGET`，不回写或替换其它 Secret。
- Worker Variables：`MEDIA_MANIFEST_KEY` 与配置的清单入口一致；`REQUIRE_MEDIA_MIGRATION=true` 在首次迁移前阻止站点发布。部署脚本自动输出这两个字段。
- 本地构建：`MOSAIC_ROOT`、`MOSAIC_DIST`、`MEDIA_MANIFEST_FILE`；输出目录必须在工作区内且不能覆盖源码或内容。媒体临时目录可用 `MEDIA_WORK_DIR`。

`SITE_BRANCH` 同时覆盖 Worker 内容 API 的 ref 和 Actions 调度分支。切换分支应更新基础设施配置与 Variables，再执行部署。校验命令为 `npm run validate`；后台配置更新也执行相同共享校验。

后台部署暂存目录默认 .mosaic/admin-dist，可用 ADMIN_DIST 覆盖为工作区内安全输出目录；scripts/stage-admin.mjs 不覆盖源码。资源版本由内容计算，不需要手动设置。
