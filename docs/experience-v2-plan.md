# Mosaic Experience v2 — 内部协作契约

> 状态：**已交付**（2026-10）。5 个工作流全部完成，task-1..task-5 completed；独立验证报告见
> `.mosaic/qa/verification-report.md`（本地工件，不入库）。实现说明见
> [handover.md](../handover.md) 的「2026-10 Experience v2」章节，交互提议见
> [interaction-proposals.md](interaction-proposals.md)，配置/API 见
> [configuration.md](configuration.md)、[api.md](api.md)、[media-guide.md](media-guide.md)。

> 本文件是全队共享的唯一接口契约。所有实现必须与这里的命名、配置键、数据格式一致；
> 需要改契约时先通知 Lead，由 Lead 更新本文件。

## v2.1 追加契约（已交付）

| 项 | 内容 |
| --- | --- |
| 配置 | `experience.card.layout: 'masonry' | 'grid'`（默认 masonry，枚举校验，旧配置自动取默认） |
| 数据 | `posts-index.json`/`posts.json`/`feed.json`/`notes/*.json` 增加 `coverLqip`（URL 或 `''`）；媒体清单 `published` 增加 `videos[].posterPreview`、`music[].coverPreview`（additive） |
| 前台 | `cards/render.js` 输出 LQIP-first 标记 + `--cover-aspect`；`cards/media.js` 渐进升级；`cards/masonry.js` 最短列打包 |
| 样式 | 圆角令牌放大 + `corner-shape: squircle` 渐进增强（WebKit 回退圆形）；不使用 clip-path/mask |
| 约束 | 不新增媒体处理配置键，不改变处理指纹；旧媒体无预览字段时回退原图；`layout='grid'` 保持旧等高网格 |

## 0. 目标（用户需求映射）

| # | 需求 | 归属工作流 |
| --- | --- | --- |
| 1 | 重构级优化（解耦/可读/可扩展） | 全员 + Lead 收口 |
| 2 | Bug 修复，重点视频解码 flow 触发 | video-pipeline（后端 flow）+ playback-quality（前端解码 flow） |
| 3 | 后台人性化 + 播放流畅 | admin-experience + playback-quality |
| 4 | 交互级提议 | Lead 文档 + showcase/overlay 落地 |
| 5 | 播放流畅度提升 | playback-quality |
| 6 | 卡片变大、卡片全图 | frontend-showcase |
| 7 | 开放主题模式 | frontend-showcase（前台）+ admin-experience（后台设置） |
| 8 | 小红书式不跳转详情弹层 | overlay-feed |
| 9 | Spring Animation 动效 | frontend-showcase（motion 核心）+ overlay/feed 使用 |
| 10 | Morphicons 图标库 | frontend-showcase |
| 11 | 视频转码补帧（ffmpeg minterpolate）+ 已解码视频后补帧 | video-pipeline（+ admin-experience 操作入口） |
| 12 | 解码后可选保留源文件 | video-pipeline（+ admin-experience 开关/提示） |
| 13 | 抖音竖屏刷视频模式（可选，手感贴合抖音） | overlay-feed |
| 14 | 解耦、可读、可扩展 | 全员 |
| 15 | 不松懈 | 全员 |

## 1. 硬约束

- 仓库根：`F:\Project\Mosaic`，当前分支 `feat/experience-v2`。**不要执行任何 git 写操作**（checkout/branch/commit/push），由 Lead 统一提交。
- 不要 `npm install`；依赖由 Lead 安装。`morphicons@2.0.2` 已安装。
- 不要运行 `npm run build` / `npm run test:e2e:local` / `npm run test:admin:local`（它们写共享 `dist/`，会互相踩）。需要本地预览时用隔离输出：
  ```powershell
  $env:MOSAIC_DIST='.mosaic/verify-<你的名字>'
  node scripts/generate-brand-assets.js; node scripts/generate.js; node scripts/minify.mjs
  ```
  然后 `npx serve <MOSAIC_DIST 绝对路径>` 或用 `tests/helpers/static-server.mjs` 起本地服务。`dist/` 最终由 Lead 统一生成。
- 只改自己 ownership 内的文件；需要改别人的文件 → 发消息给该 owner 或 Lead，不要直接改。
- 遵守 `CLAUDE.md`：媒体资源永远走 pipeline，禁止本地手动上传 R2；修根因不贴膏药。
- 代码保持原生 ESM + 无框架；新模块必须有明确单职责、JSDoc 注释、可被单测/复用。
- 视觉/动效必须尊重 `prefers-reduced-motion`，键盘可操作，axe 0 违规。
- 格式化：可对自己改动的文件执行 `npx prettier --write <files>`；可 `npx eslint <files>`。不要全仓 `prettier --write .`。
- 不引入除 `morphicons` 外的新依赖（如需请示 Lead）。

## 2. 文件 ownership（互斥）

| Owner | 文件/目录 |
| --- | --- |
| **Lead** | `src/layouts/post.ejs`、`src/assets/js/app.js`、`src/data/i18n.json`、`package.json`、`docs/**`、`README.md`、`handover.md`、最终 `dist/` 构建与提交 |
| **frontend-showcase** | `src/layouts/index.ejs`、`src/assets/css/{tokens,card,layout,responsive}.css`、`src/assets/js/theme.js`、`src/assets/js/filter.js`、新增 `src/assets/js/motion/**`、`src/assets/js/icons/**`、`src/assets/css/{motion,icons}.css`、`src/data/i18n.json`（仅追加 key） |
| **overlay-feed** | 新增 `src/assets/js/note/**`、`src/assets/js/feed/**`、`src/assets/css/{note,feed}.css`、`scripts/site/experience-data.mjs`、`scripts/site/generate.mjs` |
| **video-pipeline** | `shared/config.mjs`、`shared/media-manifest.mjs`、`scripts/media/**`、`worker/src/**`、`worker/package.json`、`.github/workflows/media.yml`、`mosaic.config.json`、`tests/media-*`、新增媒体测试 |
| **admin-experience** | `cloud-admin/**` |
| **playback-quality** | `src/assets/js/video/**`、`src/assets/js/video.js`、`src/assets/css/video.css`、`tests/video-startup.mjs`、新增播放测试 |
| **verifier** | `tests/**`（新增文件）、`.mosaic/qa/**`；只读业务源码 |

## 3. 配置契约（`shared/config.mjs` + `mosaic.config.json`）

新增（默认值如下；均向后兼容，旧配置无这些键时行为不变）：

```jsonc
{
  "theme": "auto",                       // 兼容旧键：auto | light | dark
  "themeMode": {
    "default": "auto",                   // auto | light | dark
    "accent": "blue",                    // blue | violet | emerald | rose | amber | slate
    "allowVisitorToggle": true,          // 前台是否显示主题入口
    "showMenu": true                     // 是否提供 auto/light/dark + accent 菜单
  },
  "experience": {
    "card": { "size": "large", "image": "full" },      // size: large | compact；image: full | cover
    "modal": { "enabled": true },                      // 小红书式弹层
    "verticalFeed": { "enabled": true },               // 抖音式竖屏模式入口
    "motion": { "enabled": true, "spring": "snappy" }, // spring: none | snappy | smooth | bouncy
    "morphIcons": { "enabled": true }
  },
  "media": {
    "keepSourceFiles": true                // NEW：解码成功后保留 originals（默认保留；false 时任务完成后删除并标记）
  },
  "videoQuality": {
    "interpolation": {                     // NEW：ffmpeg 光流补帧
      "enabled": false,
      "fps": 60,
      "mode": "mci",                       // mci | blend | dup
      "mcMode": "aobmc",                   // aobmc | vmm | obmc
      "meMode": "bidir",                   // bidir | epzs | esa
      "vsbmc": true
    }
  }
}
```

规则：

1. `normalizeConfig` 把旧 `theme` 字符串映射到 `themeMode.default`；若只给旧键，输出与旧行为一致。
2. `validateConfig` 校验枚举/数值范围（fps 24–120，整数）。
3. **处理指纹策略**：`processingConfig(config, 'videos')` 必须保证“未启用补帧 + 保留源文件默认值”时指纹与旧版完全一致（即 interpolation 仅在 `enabled === true` 时进入指纹；`keepSourceFiles` 永不进入指纹）。否则上线会全量重转码。
4. 补帧 `ffmpeg` 滤镜（`video-pipeline` 实现）：`scale=-2:<h>,minterpolate=fps=<fps>:mi_mode=<mode>:mc_mode=<mcMode>:me_mode=<meMode>:vsbmc=<0|1>`；仅在档位高度低于源高度或需要缩放时 scale 在前；必须保证输出 yuv420p、偶数宽高。补帧后的档位 mp4/HLS/分片仍走原有“全部 HEAD 验证后发布”契约。
5. 后补帧（已解码视频）：任务新增 `options.sourceMode = 'original' | 'processed'` 与 `options.interpolation` 覆盖。`processed` 模式从 `asset.published.sources[tier]` 下载已发布 mp4，只做补帧重编码 + 重新分片，不下载原始源文件；即使 originals 已被删除也可用。新任务使用新 generation，旧产物保留到主清单切换。

## 4. Admin API 契约（worker）

新增/扩展（均需鉴权，POST body JSON，错误沿用现有 `{ error, code }` 结构）：

- `POST /api/media/interpolate`
  - body：`{ slug: string, filename?: string, all?: boolean, fps?: number }`
  - 行为：对指定视频（或该文章全部视频 / `all=true` 表示清单内全部 video）登记新任务，`options: { sourceMode: 'processed', interpolation: {...当前配置..., fps 覆盖} }`，`force: true`，新 generation；返回 `{ ok, enqueued: N, tasks: [{ id, assetId }], skipped: [{ assetId, reason }] }`。
  - 安全：只允许 `folder === 'videos'` 且 `asset.published` 存在（已完成解码）；未完成返回 skipped。
- `POST /api/media/:id/retry`、`cancel` 等现有接口保持兼容；`enqueue` 任务对象新增 `options` 字段（DO 存储并透传给 media.yml runner）。
- 上传登记扩展：`POST /api/upload/complete/...`、`presign`、`direct`、`multipart/complete` 接受可选 body `{ keepSource?: boolean }`，透传到 `registerUpload` → `enqueue` 的 `options.keepSource`。默认取 `config.media.keepSourceFiles`。
- runner 完成（publish/complete）后：若该视频 `options.keepSource === false` 且全部档位 `complete === true` 且 `source.available !== false`，由 **DO 在串行化 publish 处理中原子执行**删除 `originals/...` 源对象，并更新 `asset.source = { ...source, available: false, deletedAt }`。必须确认 `asset.generation` 仍等于任务 generation（新上传已 supersede 时绝不删除）；失败只记录日志，不使任务失败（源文件删除是 best-effort，不能回滚已发布产物）。管理后台显示“源文件已删除，无法从源重新转码；仍可基于已发布产物后补帧”。（2026-10 决策：删除放在 DO 侧以避免 runner 侧 TOCTOU race。）
- 能力探测：`GET /api/media/interpolate` → `{ ok, supported: true, defaults }`；未部署的 Worker 返回 404，后台据此禁用入口。
- `direct` 原始字节流上传无法携带 JSON body：`keepSource` 通过 query `?keepSource=1|0` 与 `X-Mosaic-Keep-Source` header 传递；其余上传完成接口使用 JSON body 字段。
- `jobs-list` / `job` 返回 `options`（脱敏后）。

## 5. 前端模块契约（Lead 在 `app.js` 统一接线）

新模块统一 `src/assets/js/<domain>/index.js`，导出初始化函数，必须幂等、可销毁（返回 dispose 或内部 AbortController）。

```js
// frontend-showcase
// src/assets/js/motion/index.js
export function initMotion(root = document);                  // 卡片/按钮 spring、滚动 reveal（尊重 reduced-motion）
export function springTo(el, props, options = {});            // Promise；props: { scale, opacity, x, y, blur }
export function springPreset(name = 'snappy');                // -> { stiffness, damping }
// src/assets/js/icons/index.js
export function initIcons(root = document);                   // 水合 [data-morph-icon] 元素并注册全局 morph
export function setMorphIcon(el, iconName, options = {});     // 在 {from,to} 图标数据间 spring morph
export function iconElement(iconName, options = {});          // 生成 inline SVG 元素
// theme.js 保持导出 initTheme / cycleTheme，新增
export function initThemeMenu(root = document);               // 主题菜单（auto/light/dark + accent），返回 dispose

// overlay-feed
// src/assets/js/note/index.js
export function initNoteModal(options = {});                  // 点击 .post-card 打开详情弹层，不跳转；返回 { open(slug), close(), dispose() }
// src/assets/js/feed/index.js
export function initVerticalFeed(options = {});               // 注入入口按钮 + 全屏竖屏 feed；返回 { open(index?), close(), dispose() }

// playback-quality
// src/assets/js/video/playback.js
export function ensureHlsLoaded();                            // 动态加载 vendor/hls.min.js，返回 Promise<boolean>
export function createPlayback(options);                      // 统一解码 flow 控制器（HLS + MP4 回退、按需 startLoad、状态机、恢复）
// 返回 { attach(), play(), pause(), seek(t), setQuality(res), destroy(), get state(), on(event, cb) }
```

`app.js` 会按页面类型调用（list 页：note modal + feed + motion + icons；post 页：motion + icons + 现有视频初始化）。模板 CSS 链接由 Lead/A 统一加：`motion.css`、`icons.css`、`note.css`、`feed.css`。

### 主题契约

- 前台读取 `window.__MOSAIC_CONFIG.themeMode`（由模板注入），支持 `data-theme="auto|light|dark"` + `data-accent="blue|violet|emerald|rose|amber|slate"`，`localStorage` 键 `mosaic_theme`（mode）与 `mosaic_accent`。
- 首帧无闪烁：模板 `<head>` 内联脚本解析（A 更新 index.ejs，Lead 更新 post.ejs）。
- 现有 `tokens.css` 变量名不得破坏；新增 accent 变量组，默认 blue 与现有 `#4361ee` 完全一致（视觉回归零变化）。

## 6. 数据契约（SSG 生成到 `dist/data/`）

overlay-feed 在 `scripts/site/generate.mjs` 追加生成（不得改变现有 6 个 data 文件内容/格式）：

- `dist/data/feed.json`
  ```json
  { "version": 1, "items": [ { "slug": "...", "title": "...", "description": "...", "category": "...", "tags": ["..."], "date": "...", "cover": "...", "coverAspect": 0.75, "coverSrcset": {"480": "..."}, "type": "video", "poster": "...", "hls": "...", "sources": {"1080p": "...", "720p": "..."}, "duration": 12.3, "aspect": 0.5625 } ] }
  ```
  只包含 `videos.length > 0` 的文章，按现有 posts 排序；URL 使用 `mediaUrl(key, site.mediaBase)` 结果（与模板一致）。
- `dist/data/notes/{slug}.json`：单篇详情（供弹层按需 fetch，避免整站 body 常驻内存）
  ```json
  { "slug": "...", "title": "...", "date": "...", "category": "...", "tags": [], "description": "...", "cover": "...", "coverAspect": 1.5, "coverSrcset": {}, "type": "photo", "stats": {}, "bodyHTML": "<p>...</p>", "blocks": [ ... ], "photos": [], "videos": [], "music": [] }
  ```
  `blocks`/媒体字段与 post 页渲染输入一致，可直接重放内容块。

## 7. 验收标准

- `npm run check`、（最终）`npm run lint`、`npm run format:check`、`npm run build`、`npm run test:e2e:local`、`npm run test:admin:local`、`npm run test:media` 全部通过（Lead/verifier 执行）。
- 新功能可关闭：`experience.*.enabled=false` 时前台行为与旧版一致（不报错、无空入口）。
- 主题/补帧/保留源文件配置经后台保存 → Worker 校验 → 前台生效或媒体任务登记。
- 媒体任务：`options.sourceMode='processed'` 后补帧任务可在本地 FFmpeg 4.4+ 合成视频上跑通（有测试/脚本证明）。
- 前端：无 JS 控制台错误；390px / 768px / 1440px 无横向溢出；亮/暗主题 axe 0 违规。
- 代码：新增模块单文件 ≤ ~350 行，职责单一，JSDoc 注释，无循环依赖；修改旧文件时顺手拆分明显巨石函数。

## 8. 协作节奏

1. Claim 自己的 team task（`team_task_list` → `team_task_get` → `team_task_update claim`）。
2. 每完成一个里程碑给 Lead 发消息（含文件清单 + 验证命令/结果 + 需要 Lead 接线的事项）。
3. 接口依赖（如 feed 用 playback、motion 用 icons）先发消息约定，不要等待；先写薄适配层。
4. 最终把任务置为完成，并给 Lead 一份“交付报告”：改了什么、为什么、怎么验证、已知限制/风险。
5. 不要长时间静默；遇到 blocked 立刻消息 Lead。
