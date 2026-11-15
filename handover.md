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

## 2026-10 Experience v2（大卡片/主题/弹层/竖屏/补帧/解码 flow）

分支 `feat/experience-v2`，16 项需求的实现与验证记录，协作契约见
[docs/experience-v2-plan.md](docs/experience-v2-plan.md)，交互提议见
[docs/interaction-proposals.md](docs/interaction-proposals.md)。

- **前台**：卡片渲染统一到 `src/assets/js/cards/render.js`（SSG 与客户端同源），大卡
  full-bleed 全图 + 紧凑文字卡；主题三态 auto/light/dark + 6 套 accent（后台默认值/访客切换
  权限），首帧无闪烁；Spring 动效核心（无动画库）与 Morphicons 状态图标；类小红书详情弹层
  （不跳转、`?note=` 深链、焦点陷阱/滚动锁、按需 `data/notes/{slug}.json`）与类抖音竖屏 feed
  （按需 `data/feed.json`、一次只播一个、意图预载 ±1）。
- **播放**：`src/assets/js/video/playback.js` 成为唯一解码 flow 控制器（intent-gated：
  attach 零请求、pointerdown 只 prewarm master、play 后 MANIFEST_PARSED 才 startLoad；首点
  意图重放；3 次致命错误降级 MP4；稳定位置键）。修掉“第一次点击无反应”的根因；播放器拆分为
  player/events/progress/gestures/quality/feedback/keyboard 等模块。
- **媒体**：`videoQuality.interpolation`（ffmpeg 光流 minterpolate，单遍/档位）与后台
  “后补帧”接口 `GET/POST /api/media/interpolate`（从已发布 MP4 重编码，不依赖 originals）；
  `media.keepSourceFiles` / 上传级 `keepSource`（DO 在完整发布后原子删除源并标记
  `source.available=false`）；处理指纹在补帧关闭时与旧版逐字节一致，不触发全量重转码。
- **媒体 flow 触发修复**：任务协调器持久化 `mediaDispatch` 状态机（idle/dispatching/active/
  retry + runId/backoff），只在确有待办且无排队/运行中 run 时 dispatch；runner 中断可恢复；
  站点构建 dispatch 与媒体 dispatch 解耦。根因与测试见 `worker/src/jobs/media-dispatch.mjs`、
  `tests/media-dispatch-smoke.mjs`。
- **后台**：配置页拆分模块并新增主题/体验/补帧/保留源文件分区；补帧操作入口（单条/整篇/全部，
  能力探测 404 优雅降级）；上传保留源文件开关与处理计划；命令面板/轮询拆分、骨架屏与局部重试、
  移动端抽屉、跳过链接与焦点管理。
- **验证**：`npm run check`、`lint`、`format:check`、`build`、`test:e2e:local`（含真实 HLS /
  动态 hls.js / 播放指标）、`test:admin:local`、`test:media`（含真实 ffmpeg 补帧）与独立
  verifier 报告 `.mosaic/qa/verification-report.md`；发布前照旧运行 Verify 工作流。
- **部署注意**：本次改了 Worker（任务 options/调度状态机/补帧接口）、后台与前台，需要按
  Infrastructure → Site/Admin 顺序发布；静态站点与媒体清单契约保持兼容。补帧与源文件保留
  属于可选能力，默认关闭/保留，不影响现有媒体。

## 2026-10 Experience v2.1（瀑布流 / LQIP 预览图 / 超椭圆圆角）

在 v2 基础上追加的三项体验升级，核心契约仍见
[docs/experience-v2-plan.md](docs/experience-v2-plan.md)。

- **瀑布流卡片**：默认 `experience.card.layout='masonry'`。每张卡片高度由封面比例决定
  （显示比例夹取 0.62–1.5），列内首尾相接；CSS 多列为无 JS 回退，`cards/masonry.js` 水合后
  按最短列绝对定位打包（规避 WebKit 对 aspect-ratio 卡片的分栏 0×0/跨列 bug）。
  `layout='grid'` 可一键切回等高网格，后台“体验 → 列表布局”可切换。
- **几 KB 预览图（LQIP）**：图片复用既有 `placeholder.webp`；视频新增 `poster-preview.webp`、
  音乐新增 `cover-preview.webp`（均 150px / q30，约 1–6KB，**不新增处理参数，指纹不变**）。
  SSG 输出 `coverLqip`；卡片先渲染预览（模糊），`cards/media.js` 在首屏优先/接近视口时
  解码高清并原位替换，`saveData` 时停留预览；`<noscript>` 回退高清，升级前后无 CLS。
- **超椭圆圆角与悬浮**：设计令牌放大（卡片 26px、弹层 34px、按钮 14px）；Chromium 等支持
  `corner-shape: squircle` 的浏览器呈现连续曲率，WebKit/Safari 回退同半径圆形圆角。
  卡片悬浮使用采样后的欠阻尼 spring（上浮 7px + 轻微放大，带回弹收敛），列间距加大到
  32px（桌面）/ 24px（平板），视觉更松弛。未采用固定像素 clip-path/mask（阴影裁剪、
  响应式重算等兼容问题）。
- **验证**：新增 `tests/preview-smoke.mjs`（纯 Node）、`tests/cards-media.mjs`（Chromium +
  WebKit 的 LQIP/瀑布流/卡片尺寸回归，并入 `test:e2e:local`）；`site-smoke`/
  `media-integration`/`generate-data-smoke`/`config-smoke`/`admin-local` 增补断言；
  独立 verifier 报告 `.mosaic/qa/verification-report-v2.1.md`。旧媒体没有预览字段时自动回退
  原图，重新处理即补齐；无需全量重转码。

### 2026-10-25 合入 main 并上线（Experience v2 + v2.1）

- 代码提交 `def2e52`（含 `f3aebb5` 主体、`c2f57ee` 视觉打磨、`def2e52` 瀑布流间距单位/
  弹层圆角/WebKit e2e 稳定性修复），已推送 `main` 与 `feat/experience-v2`。
- Actions：[Verify #40117300414](https://github.com/YupenBob/mosaic/actions/runs/40117300414)、
  [Infrastructure #40117300474](https://github.com/YupenBob/mosaic/actions/runs/40117300474)、
  [Site #40117300569](https://github.com/YupenBob/mosaic/actions/runs/40117300569)，均成功；
  Worker、后台与站点均已发布。
- 线上核验：`build-snapshot.json` 的 `gitSha=def2e52...`；首页 14 张卡片为 JS 瀑布流
  （gap 32px、圆角 26px、Chromium squircle）、单应用包 `app.871dab9a3041ebb0.js`；
  `/api/health` 正常，新 Worker 路由 `/api/media/interpolate` 返回 401（存在但需鉴权）；
  后台 bundle 含 `cardLayout`/`media/interpolate`/`keepSourceFiles` 新能力；无 console 错误。
- 说明：线上存量 14 篇中 8 篇卡片已有 LQIP（图片封面）；旧视频封面暂无 `posterPreview`，
  自动回退高清海报，后续重新处理媒体即补齐预览。回退：上一成功部署为 `aad8bd4` 的站点/后台，
  保留当前媒体清单与 Durable Object 命名空间，Worker 回退使用 Infrastructure 工作流对应
  历史版本。




### 2026-11-01 P0–P2 审计修复上线

- 代码：`main` 合并提交 `0e37f31`（PR #7），来自 `fix/p0-p2-audit`
  （`7ad55fd` worker 安全/Stats v2/content overlay、`0bb2755` 构建正确性/媒体管线/产物、
  `aa5f6f2` CI/部署/可观测/边缘、`515ebff` CSS bundle 生成时机、`e5df918` 瀑布流重排 + WAF 降级）。
- 上线：Infrastructure（Worker + admin + WAF 步骤）与 Site（build→e2e→Pages）均成功；
  Site 首次 push 因**新旧签名窗口**（新脚本带 nonce、旧 Worker 不识别）失败，
  Infrastructure 完成后手动 `workflow_dispatch` 重跑成功。后续发布保持
  Infrastructure → Site 顺序，或先在分支上验证。
- 线上核验：`build-snapshot.gitSha=0e37f31`；首页只引用 `assets/css/bundle.css`（76.6KB）、
  `screenshot.png` 404；`/api/stats/posts`、`/api/stats/traffic` 401；`/api/media/file/site-data/*`
  404（favicon 除外）；`/api/media/object?key=site-data/*` 400；track 非法 slug 400；
  Range 回源 206；Stats DO 迁移后 16 个 slug 的 views/likes 与迁移前备份逐项一致，
  `site-data/stats.json`（含历史 `_recentIps`）已从 R2 删除；probe 13 passed / 4 warnings。
- **残余风险 R-0（已与用户确认降级上线）**：媒体自定义域上 `site-data/*`（manifest、posts-index、
  media-manifests、迁移标记）仍然公开，因为仓库缺少 `CLOUDFLARE_ZONE_ID` 且现有
  `CLOUDFLARE_API_TOKEN` 未验证 WAF 权限。补完步骤见 `docs/security-media.md` 的“渐进上线”：
  ① 配置 Zone ID/必要时 `MEDIA_ORIGIN`；② 手动 dispatch `infrastructure.yml`，确认 WAF 步骤
  写入规则（默认降级、`--strict` 才失败）；③ 跑 `probe.mjs` 确认私有前缀 403/404 后打开
  `PROBE_STRICT_PRIVATE`，并把 WAF step 改为 `--strict`。
- 其他残余：`drafts/`、`previews/` 依赖 WAF 落地才真正私有（探测当前 404 只是对象不存在）；
  `originals/` 按设计继续公开（18 处图集原图依赖，EXIF 隐私待媒体回填后收窄）；
  `/data/posts.json` 已不再随构建发布，但旧 CDN 缓存可能仍返回数天；Dependabot 已启用，
  会持续开依赖升级 PR。
- 回退：Pages 用 `rollback.yml`（默认 dry-run，`confirm=rollback` 才执行）到上一个
  deployment；Worker 用 `wrangler rollback`；Stats 旧 `stats` key 保留 30 天供旧代码读取；
  迁移前统计备份在本地 `.mosaic/backup/`（未入库）。

### 2026-11-14 QA 轮次 0/1：后台保存无损 + YAML frontmatter + 404 修复

- 背景：以用户行为为入口的 QA 计划开始执行。Round 0 发现 **P0 数据完整性缺陷**：
  后台编辑器保存会把 `category: null` 写成字符串 `"null"`、把日期截断成日期、丢 tags/media、
  并把正文 `{{video:0}}` 改写成 `{{gallery}}`。生产两篇内容已被该缺陷改坏
  （`ebb0241 Update fsdfsdgsfgsd`、`d4efa33 Update text-only`）。
  根因：Worker 用逐行正则解析 frontmatter（`github-client.js`），后台编辑器再按字符串回写。
- 代码：PR #16（合并提交 `01dd3a9`，来自 `release/qa-round1`）
  - Worker：改用 `js-yaml` 解析 + 类型化 normalize（日期/null 哨兵/tags/media/统计数字，
    旧的无标题文章保持 null 可无损保存）+ `js-yaml dump` 序列化、保留正文空白；
    新增 `tests/frontmatter-roundtrip.mjs`（14 篇文章全量往返 + 边界 + mock 保存）并入 `test:unit`。
  - 后台：直接保存与云草稿共用类型化收集器（日期保留时间、空值为 null、media 不丢）；
    正文未编辑时原样回写（不再重排占位符）；新增 `admin-roundtrip*` 浏览器回归（修复前 3/3 红，修复后绿）。
  - 站点：404 页面改为根相对链接（深层 404 的“返回首页”不再指到 `/posts/<slug>/index.html`）；
    本地测试服务器对未知路径回退 `404.html`，新增嵌套 404 用例。
  - 内容：把 `text-only`/`fsdfsdgsfgsd` 恢复到 `2906789` 的已知良好元数据。
- 验证：Verify #43618760754 全绿（含 Chromium+WebKit e2e）；Infrastructure/Site 部署成功；
  生产 `build-snapshot.gitSha=01dd3a9`；`/data/posts-index.json` 分类/日期/tags 已恢复；
  深层 404 返回根相对 `index.html`；后台只读巡检测试 4/4 绿，编辑器加载
  `text-only`（随笔/极简/2026-05-01）与 `fsdfsdgsfgsd`（空分类/空描述/2026-08-03）均为类型化值，
  证明新 Worker 解析已在线上生效；`probe.mjs` 13 passed / 4 warnings（WAF 残余同 R-0）。
- 新增 QA 资产（仓库内）：`tests/ux/`（Playwright 旅程框架：公开/媒体/后台/移动无障碍/性能）、
  `scripts/qa/`（本地全量站点构建、旅程 runner、目录合并）、`docs/qa/`（行为目录，
  当前 134 条，含通过/失败/阻塞状态）、`qa/reports/`（本地证据，gitignore）。
- 测试稳定性：`tests/cards-media.mjs` 改为等待揭示动画结束并读取布局几何（offset*），
  消除慢机/WebKit 下的亚像素波动。
- 回退：上一成功站点/后台为 `d4efa33`；Worker 用 Infrastructure 历史版本回退；
  内容回退到 `2906789` 的对应文件。

### 2026-11-14 QA 轮次 2/3/4：移动无障碍/SEO、后台正确性、故障与安全

- 范围：Round 2 媒体/移动无障碍/性能、Round 3 后台写路径（本地 mock）、Round 4 故障注入/边界/安全，
  共 226 条行为目录（177 pass / 49 blocked，blocked 均为缺测试条件或非产品需求）。
- 修复与上线（两批）：
  - `38cfdcc`（PR #18，QA 轮次 2/3）：移动端主题/导航/筛选/浮层按钮 44px 触摸目标；
    主题菜单 Escape 同步回焦；访客页 skip link 与 `main` 焦点目标；文章视频 `aria-label`；
    每页 canonical（首页/文章/分类/标签/分页）与媒体域 preconnect；404 `noindex`；
    搜索/音量滑块可见焦点环。后台：`#build` 手动刷新绕过 3s 读缓存；仪表盘统计卡片各自
    落地加载、taxonomy `null` 归入“未分类”；taxonomy 删除能力改为 `GET /taxonomy`
    的 `capabilities.delete`（页面加载不再发 DELETE 探测）。Worker 增加能力字段。
  - `f45b319`（PR #19，QA 轮次 4）：`/api/track/{view,like,dwell}` 用 R2 已发布索引
    校验 slug（未知 slug → 404 `UNKNOWN_POST`；索引缺失时 fail-open 不丢真实统计，
    per-isolate 30s 缓存）；搜索索引加载失败时禁用输入并显示可见提示（SSR 卡片保持可用），
    不再静默失效。
- 线上核验（release 3）：`build-snapshot.gitSha=f45b319`；`probe.mjs` 13 passed / 4 warnings
  （WAF 残余同 R-0）；未知 track slug 404 `UNKNOWN_POST`，合法 slug 200；首页/文章 canonical、
  preconnect、视频 `aria-label` 均在线；后台只读巡检 4/4 绿、0 写请求；首页/分类/标签/404 正常。
- 测试稳定性/防回归：`tests/cards-media.mjs` 等揭示动画结束并读布局几何；axe 扫描等待动画
  结束（消除暗色卡片对比度误报）；D-06 用真实 320px reflow 取代 CSS-zoom 代理；
  `admin-roundtrip` 修复前 3/3 红、修复后绿；新增 `edge-faults`/`edge-prod`/`admin-writes`/
  `site-polish`/`media-playback`/`mobile-a11y`/`perf` 旅程与 `status-overrides.json` 目录校正。
- 已知残余/后续 backlog（不阻塞上线）：
  - WAF 未落地（R-0）：`site-data/*` 在媒体域仍公开，需 Zone ID 后按 `docs/security-media.md` 上线；
  - 49 条 blocked 行为：多视频/音乐内容缺失、后台上传/删除/历史恢复等写分支需要更完整 mock，
    离线首访（无 Service Worker）非产品需求；
  - `enableBusuanzi: true` 会在文章页引入第三方统计（配置选择，性能/隐私提示）；
  - 依赖升级 PR（Dependabot）待评估。
- QA 资产：`tests/ux/`（7 个旅程 spec + lib）、`scripts/qa/`（本地全量构建/runner/目录合并）、
  `docs/qa/behaviors.json` + `behavior-catalog.md`（226 条，含状态与覆盖来源）、
  每轮证据在 `qa/reports/round-N/`（gitignore）。

### 2026-11-15 深入 QA 轮次 5–9：浮层交互、媒体/搜索/分页、后台写分支、安全与语义

- 新增 **fixture 环境** `scripts/qa/build-fixtures.mjs`：65 篇内容的临时站点（playlist 三视频帖、双曲目音乐帖、
  HLS/MP4/损坏 HLS 变体、嵌套与特殊字符分类、XSS 元数据帖、作者信任 HTML 帖、分页 4 页），
  搭配合成媒体服务（多档 HLS/ts、MP4、MP3、JPEG，CORS/Range），旅程 `--target fixtures` 一键复现。
- 行为目录扩到 **330 条（244 pass / 86 blocked / 0 fail）**，新增 11 个深测 spec（feed/note/gallery/player/
  music/search/pagination/admin-deep/security/seo/fixture-smoke），共 22 个 spec。
- 修复（PR #20，合并 `c593b7b`，Infrastructure + Site 均成功）：
  - 画廊查看器改为真正的模态：焦点进入/陷阱/返回、拖拽边界钳制、`+/-/0` 键盘缩放、放大后单指平移、
    坏图占位且导航可继续；双指缩放保持；
  - 垂直 feed：点击背景关闭并回焦、`?feed=<slug>` 可分享/刷新恢复；
  - 笔记弹层：关闭按钮 44px、轮播 aria-live 数字计数；
  - 音乐播放失败显示可见错误并可重试；搜索清除后恢复首屏分页切片（过滤态仍全站搜索，已记录）；
  - SEO：分类/标签 og:url 用页面 canonical、404 补充社交/描述元数据、sitemap 纳入 `page/N`；
    Pages `_headers`（HTML revalidate、hashed JS immutable、CSS 1h、data 5min）；卡片/相关封面按宽高比占位；
  - 后台：删文章需回填 slug、启动构建需确认、确认框按钮在精确文本匹配前禁用、草稿列表新增预览；
  - Worker：公开 track 端点 8KiB 体积上限（合法超限 → 413 `PAYLOAD_TOO_LARGE`）。
- 线上核验（`c593b7b`）：`probe.mjs` 13 passed / 4 warnings（WAF 残余同 R-0）；HTML `max-age=0, must-revalidate`、
  哈希 JS `immutable`、CSS `max-age=14400`；合法超大 track body → 413，非法 JSON → 400；深层 404/后台只读 4/4、
  admin 只读巡检 4/4 全绿；SEO/安全旅程在本地+生产读数 4/4 全绿。
- 残余 backlog：86 条 blocked（后台部分写分支 mock 不足、无 Service Worker 的离线首访、音乐/多视频内容形态、
  速率限制测试受匿名写预算限制、WAF 落地前 site-data 仍公开、legacy 相关封面仍有 960px 源）；
  `enableBusuanzi` 第三方统计为配置选择。
