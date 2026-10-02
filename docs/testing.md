# 测试指南

默认检查与生产验证分开。`npm run check` 不读取 `.env` / `.dev.vars`，不连接 GitHub、R2 或生产 API，不运行 FFmpeg。

| 层 | 命令 | 验证 |
| --- | --- | --- |
| 静态 | `npm run validate`、`npm run lint`、`npm run format:check` | 共用配置、ESLint、格式、代理同步和模块语法 |
| 离线 | `npm run check` | 所有模块语法、13 组内容块、6 组上传逻辑、原 38 组 Worker、Jobs/上传/配置/站点契约 |
| 媒体集成 | `npm run test:media` | 本地 FFmpeg + Sharp 合成文件、内存 R2、隐私与发布验证 |
| 浏览器 | `npm run build` 后 `npm run test:e2e:local` | 现有内容搜索和路径回归，以及合成清单的移动 Chromium/WebKit 媒体回归 |
| 后台浏览器 | `npm run test:admin:local` | 本地文件服务、完全 Mock API、路由、编辑器、任务重试/取消/轮询清理、7 页面×2 主题 axe |
| 显式线上 | `npm run test:online` | 原有线上探针与真实后台；仅按需运行，使用独立凭据 |

首次浏览器运行执行 `npx playwright install chromium webkit`。媒体测试需要 FFmpeg 在 PATH；这些测试只处理合成文件，不上传用户媒体。浏览器使用提交的合成颜色视频、正弦音频和色块图（base64 fixture），所以站点工作流仍不需要 FFmpeg。

## 关键验收

`site-smoke` 在临时工作区中只复制源码、Markdown、配置和清单：没有 photos/videos/music 原文件目录，没有 FFmpeg、checksum 缓存或存储客户端，仍生成图文、HLS/MP4、音乐及深层分类。重建清空陈旧页面，列表数据没有 bodyHTML、blocks、photos、videos、music 或 waveform。

`jobs-smoke` 验证 DO 重启、可靠登记、R2/GitHub 故障 outbox、重复任务、租约到期、断点续跑、同名替换旧输出、删除/取消、有限重试、旧回调 409、签名鉴权、部署快照固定、新变更不被旧部署确认和引用清理保护。

另覆盖 1200 条任务分页恢复、128 KiB 单记录约束、首次迁移保护、配置补处理游标恢复，以及缺失引用清单时停止清理。`list-index` 断言媒体更新时首次列表只读取一份 R2 索引、重复读取命中内存且不请求 GitHub 正文。

`upload-jobs` 覆盖直传、预签名确认、分片确认、批量登记、重复确认与重启。`media-integration` 使用实际图像/音视频，验证低档先发布、高档续跑、master 不变性、上传失败不产生引用及旧播放列表缺片时不能上线。

前台浏览器验证模板曲目数据保留、实际已发布档位菜单、HLS 失败回退 MP4、播放列表实例销毁、移动端无溢出和双主题无严重/关键 axe 错误。后台要求所有 axe 违规为零。

`experience-local` 使用独立 HTTP 媒体服务与真实合成 HLS 分片，在 Chromium 中保留 HTTP 缓存并播放；先用无 Origin 请求预热旧 URL，再验证新的 CORS 请求、暖缓存、暂停时零分片、脚本加载前点击、断点恢复、清单失败回退和仅低档位播放。WebKit 验证真实 MP4；Windows WebKit 的 MSE 解码器不等同于 Safari，HLS 控制逻辑另由原 WebKit 可控引擎用例覆盖。此测试不调用 `page.route`，因为 Playwright 请求拦截会禁用浏览器 HTTP 缓存。生产域与实际 Safari 仍须线上验证。

`admin-experience` 模拟慢/失败统计接口，验证操作入口无需等待统计、配置请求合并、搜索与分类叠加、实际封面、孤立封面、第二个视频封面、轮询时光标保留、三种上传路径，以及确认失败只重试确认、处理失败只重试任务、退出后停止前台轮询而已确认任务继续。`admin-client` 覆盖多个请求消费者独立取消、缓存失效和读写超时；`media-list` 对照编辑器与构建的媒体索引。

CI `verify.yml` 执行四层离线验证且没有生产 Secrets。旧 browser spec 只在本地运行四项路径与搜索检查，并阻止外部请求；媒体用例由新合成清单覆盖。测量方法见 [performance.md](performance.md)。

published-assets 验证内容哈希稳定性、后台打包无模块加载链、依赖变更使整图版本变化、Pages 代理不被重写和输出路径保护。后台浏览器用例运行实际部署暂存产物，并验证仅一个应用脚本请求；未保存保护通过真实取消/放弃操作验证。video-startup 覆盖默认低档、配置覆盖、自动升档未锁定、240p 手动偏好与不可用偏好回退。

仪表盘回归让分类先返回、流量先失败再重试，使用真实 Chart.js 验证流量恢复、旧图表销毁、实例数量有界与页面退出清理；同时检查健康标题结束加载、迟到配置补上站点链接、空站点入门提示和操作节点保留。后台图表不再以接口返回顺序决定是否显示。
