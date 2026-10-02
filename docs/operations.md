# 运维指南

## 工作流

| 工作流 | 触发 | 处理范围 |
| --- | --- | --- |
| Mosaic Site / pipeline.yml | 内容 push、手动、DO 调度 | 取清单快照、生成、离线检查、浏览器回归、Pages 部署、缓存与确认 |
| Mosaic Media / media.yml | DO 调度、手动 | 迁移一次、处理队列、验证并发布、清理未引用旧版本 |
| Mosaic Infrastructure | Worker/后台 push、手动 | 共享校验、Worker dry-run、任务绑定、后台与代理环境配置 |
| Mosaic Verify | push/PR/手动 | 无生产 Secrets 的完整离线检查、FFmpeg 合成媒体、浏览器测试 |
| Health Check | 原有定时巡检 | 现有生产健康检查 |

生产上传只在媒体 Actions 中执行。站点工作流没有 rclone、EXIF 工具、FFmpeg、checksum cache、原文件同步或媒体上传步骤。部署后仅上传小型 site-data 列表缓存。`API_TARGET`、桶、分支、超时与项目由配置/Variables 输出，密钥由 Secrets 提供。

## 排查

- pending 长时间无 run：检查任务 outbox、GitHub Actions 权限、workflow 文件名及 ref、同分支并发。调度失败不丢任务，由 alarm 重试。
- running 租约到期：中断 runner 会在 lease 到期后进入有限重试，已发布低档不丢失。检查运行日志、FFmpeg 退出状态与 R2 上传验证。
- failed：后台显示原始错误，解决后重试；默认首次失败之后重试三次。
- 回调 401：核对 Worker/Actions PIPELINE_SECRET、签名原始 body 与时间戳；不要复用管理员 JWT。
- 回调 409：租约过期或源被替换/删除，旧任务不得继续发布；检查新 taskId。
- 已部署仍 dirty：构建开始后有新改动，或源码 SHA 没覆盖最新内容，保持提示是预期行为。
- 媒体 CORS：R2 公共域允许站点/后台读取 HLS、MP4、MP3；上传允许 PUT 并 expose ETag，分片上传使用签名 endpoint。已有 Transform Rule/PROXY_SECRET 机制保留。
- 代理 503：为两份 Pages Function 配置 API_TARGET，再发布。基础设施脚本按 Cloudflare PATCH 只更新 API_TARGET，不回写其它 Secret。

## 清理

独立媒体清理扫描 processed 版本，超过 `media.retentionDays` 且没有清单、断点、正在构建或保留部署引用的对象才删除。后台孤儿清理也保护这些引用。缓存刷新重新排队，不删除在线产物。回退见 [migration.md](migration.md)。

## 配置与部署

生产分支默认 main，可通过 SITE_BRANCH 覆盖；Worker 内容 GET 与写入使用同一分支。改配置后核对基础设施 Variables 与 JSON 目标。首次启用必须先部署 Worker 和 Secret，再迁移媒体，最后切换站点工作流；不要将三条初始流程同时启动。

相关官方契约：[DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)、[Pages 项目 PATCH](https://developers.cloudflare.com/api/typescript/resources/pages/subresources/projects/methods/edit/)。

## 上线记录

[2026-10-01 全项目重构与媒体解耦上线](rollout-2026-10-01.md)：工作流运行、清单核验、真实移动端播放、后台验收、部署及回退标识。

体验排查与缓存回归见 [2026-10-02 记录](experience-2026-10-02.md)。播放故障检查必须保留浏览器 HTTP 缓存；请求拦截测试不能替代缓存验证。发布策略变更可调 player.requestVersion，以稳定命名空间避开旧无 Origin 响应。

后台必须先运行 `node scripts/stage-admin.mjs` 再部署 `.mosaic/admin-dist`，生成一个应用入口与内容版本。Infrastructure 的触发范围包含暂存/配置脚本、共享配置和依赖文件，修改发布代码也会执行检查与兼容部署。
