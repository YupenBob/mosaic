# Mosaic 项目交接

本次交付分支为 `codex/project-refactor`，保留 Node、Hono、EJS、原生 JS、Cloudflare Pages/R2/Worker 与 GitHub Actions。宣传视频目录 `video/` 和 `backup_jdcloud.py` 不属于业务重构或提交内容。

## 入口与职责

| 入口 | 职责 |
| --- | --- |
| `npm run build` | 只消费源码、Markdown、配置、媒体清单，生成干净站点 |
| `pipeline.yml` | 固定快照、构建、验证、部署、列表缓存和签名确认 |
| `media.yml` | 迁移、领取任务、单文件增量处理、上传验证、保存断点 |
| `infrastructure.yml` | Worker/任务 DO、后台与 Pages 代理配置 |
| `verify.yml` | 静态、离线、合成媒体、浏览器四层回归，无生产 Secrets |
| `worker/src/jobs-do.js` | 事务登记、alarm outbox、租约、清单、补处理与部署记录 |
| `worker/src/services/` | 内容、配置、工作流、缓存、媒体登记和引用保护 |
| `cloud-admin/js/router.js` / `lifecycle.js` | 页面作用域、退出时中止请求/事件/定时器 |
| `src/assets/js/video/` | 引擎、控制面板、播放器、播放列表、恢复与销毁 |

配置默认值、旧字段映射与校验集中在 shared/config.mjs。密钥来自显式环境或 Secrets；默认检查不会加载 .env / .dev.vars。Stats DO 的 STATS/v1 与 Pages IP 签名代理保留。

## 媒体与发布规则

三种上传完成后在返回成功前登记任务，响应有 taskId/status。DO 将任务、媒体项、构建分开存储，分页恢复，状态和 alarm 事务写入。GitHub/R2 故障保留 outbox；任务默认三次重试，耗尽后在后台重试。

当前清单入口可配置，快照为 site-data/media-manifests/{revision}.json。媒体 ID 为 slug/folder/filename；源 ETag 或处理指纹变化生成新 generation。产物为 processed/{slug}/{folder}/{generation}/...，清单记录实际键，不从本地目录推算。

首次上传显示占位；同名替换继续使用旧 published。视频档位的 MP4、HLS 分片、播放列表和海报全部验证后才发布，低档先上线，高档续跑时写新 master。预算到期中断进程、保留已发布断点并继续排队，不扣失败重试次数。配置变更登记持久补处理游标，仅处理指纹改变的项。

内部流水线接口使用独立 PIPELINE_SECRET 签名；媒体进度另绑定 taskId/runId/token/generation。站点部署绑定实际 checkout Git SHA、清单版本和脏版本。浏览器 /api/build/done 不能清空脏标记。旧部署不能确认新编辑；列表缓存上传失败时继续从 GitHub 读取内容。

清理保护当前清单、任务断点、在构建快照与保留部署；引用快照缺失时停止删除。后台重新处理媒体保留旧产物直到新版本就绪。完整 posts.json 读取兼容一个发布周期。

## 验证与运维

```powershell
npm run check
npm run lint
npm run format:check
npm run test:media
npm run build
npm run test:e2e:local
npm run test:admin:local
```

媒体测试需要本地 FFmpeg；浏览器需 npx playwright install chromium webkit。默认 check 不需要 FFmpeg、原始媒体、缓存、网络或生产凭据。覆盖原 38 组 Worker、1200 记录恢复、三种上传、同名替换、配置变更、乱序回调、迁移保护与清理。合成媒体验证真实编码；浏览器覆盖移动播放、播放列表、画廊、音乐、内容块、搜索与双主题可访问性。

首次切换先保存旧部署和清单、配置相同 PIPELINE_SECRET，暂停站点自动发布，再依次部署 Infrastructure、运行 Media 迁移、启用 Site。REQUIRE_MEDIA_MIGRATION=true 阻止空清单发布。生产媒体仅在 Actions 上传，不手工从本地传输。

回退使用上一成功 Pages 部署及其 Git SHA/清单 revision；保留 JOBS 与 STATS 命名空间，停止新媒体任务后再恢复旧流程，不删除旧 generation。

2026-10-01 已通过 PR #3 合入 main，并完成 Infrastructure → Media → Site 切换。线上清单 revision 1 保留 14 项 ready 媒体，旧视频未重新转码，站点签名确认后 dirty 为零；真实移动 Chromium HLS、WebKit MP4 和后台只读巡检已通过。工作流运行、部署及回退标识见 [上线记录](docs/rollout-2026-10-01.md)。

详见 [架构](docs/architecture.md)、[配置](docs/configuration.md)、[API](docs/api.md)、[测试](docs/testing.md)、[性能](docs/performance.md)、[迁移](docs/migration.md)、[运维](docs/operations.md)。

## 2026-10-02 体验修复

见 [体验排查与验证](docs/experience-2026-10-02.md)。新增缓存开启的真实 HLS/MP4 测试，以及慢后台、上传确认失败、任务重试、封面和编辑光标用例；命令已并入现有 CI。媒体处理、清单和站点发布契约保持兼容，播放策略不进入媒体处理指纹。

后台现在部署 .mosaic/admin-dist；先执行 node scripts/stage-admin.mjs，生成单个后台 ESM 入口及内容版本。前台发布文件名包含内容哈希。不要绕过此步骤部署源码，否则会重新引入模块下载链和 4 小时旧缓存。HLS 默认从最低已发布档开始自动升档，player.hls.startLevel 可覆盖，手动清晰度优先；这些策略不使媒体重新编码。

2026-10-03 追加修复已通过 PR #5 上线，代码为 b565dd0、清单 revision 9。线上同浏览器跨部署缓存、暖重载和最低档首片均核验；main 的 Verify/Infrastructure/Site 全部成功。实际部署与回退 ID、网络样本及真机 Safari/iOS 的验证限制见体验记录和测量 JSON。

同日 PR #6（d075f80）修复仪表盘接口乱序返回后的标题、图表、站点链接和入门提示；后台已部署并核验真实流量图与图表清理。前台沿用 b565dd0，媒体清单保持 revision 9。部署、验证运行与同浏览器更新记录见体验文档的仪表盘章节。
