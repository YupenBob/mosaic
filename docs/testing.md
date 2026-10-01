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

前台浏览器验证模板曲目数据保留、实际已发布档位菜单、HLS 失败回退 MP4、播放列表实例销毁、移动端无溢出和双主题无严重/关键 axe 错误。后台要求所有 axe 违规为零。HLS 网络恢复使用可控引擎 Mock；真实 FFmpeg 分片与对象验证属于媒体集成测试，生产跨域与真实网络播放仍由显式线上检查核验。

CI `verify.yml` 执行四层离线验证且没有生产 Secrets。旧 browser spec 只在本地运行四项路径与搜索检查，并阻止外部请求；媒体用例由新合成清单覆盖。测量方法见 [performance.md](performance.md)。
