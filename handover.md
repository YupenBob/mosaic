# Mosaic 项目交接文档

## 1. 项目概述

Mosaic 是一个**静态多媒体站点生成器框架原型**（类似 Hexo），目标是打造"个人B站"。功能涵盖图片画廊（缩放/多清晰度）、HLS 视频流、音乐播放、文章系统、实时统计。

**核心原则**：
- 这是框架原型，不是一次性网站 —— 所有设计以"未来数千用户开箱即用"为出发点
- 媒体文件从不手动本地传输，完整链路：Admin 上传 → R2 originals → GitHub Actions 压缩 → R2 processed → CF Pages 展示
- 修复从根源，不贴膏药

---

## 2. 域名与基础设施

| 用途 | 域名 | 类型 |
|------|------|------|
| 前台网站 | `mosaic.xsanye.cn` | CF Pages |
| 后台管理 | `mosaic-admin.xsanye.cn` | CF Pages |
| Worker API | `mosaic-api.xsanye.cn` | CF Workers |
| R2 媒体存储 | `mosaic-media.xsanye.cn` | CF R2 公开桶 |

### R2 桶信息
- 名称：`mosaic-media`
- Worker 绑定名：`MEDIA`
- 前缀结构：`originals/{slug}/{folder}/{filename}` / `processed/{slug}/{folder}/{filename}` / `site-data/`

### GitHub
- 仓库：`YupenBob/mosaic`
- Actions 工作流：`pipeline.yml`

---

## 3. 架构与数据流

### 3.1 完整链路

```
Admin 上传文件
  → Worker (POST /api/upload/direct) → R2 originals/
  → GitHub Actions 触发 (push .build-trigger)
  → scripts/compress.js 压缩图片(WebP) + 视频(HLS)
  → scripts/generate.js 生成静态 HTML (EJS 模板)
  → scripts/upload.js rclone上传 → R2 processed/
  → strip media/ 目录
  → wrangler pages deploy → CF Pages
```

### 3.2 API 请求路径

```
Admin 浏览器 → /api/* (同源) → Pages Functions 代理 → Worker API (mosaic-api.xsanye.cn)
前台浏览器 → /api/track/* → Pages Functions 代理 → Worker API
媒体文件 → https://mosaic-media.xsanye.cn/processed/... (直连 R2)
```

### 3.3 组件关系

```
cloud-admin/          (Admin SPA — CF Pages 独立项目)
  functions/api/[[path]].js   (Pages Functions 代理到 Worker)
  index.html + js/（ES 模块 SPA，无框架）
  src/api.js                  (API 封装)

worker/               (Cloudflare Worker — Hono 框架)
  src/index.js                (路由入口)
  src/shared.js               (共享常量/CORS/StatsDO 客户端/并行 R2 遍历工具)
  src/routes/                 (按域拆分：health/stats/media/posts/build/config/taxonomy/admin)
  src/github.js               (GitHub API + 内存缓存 + 脏标记)
  src/r2.js                   (R2 上传/列表/文件服务)
  src/auth.js                 (JWT 认证 + 登录/track 限流 + PROXY_SECRET IP 校验)
  src/stats-do.js             (Stats Durable Object — 视图/点赞/停留计数，串行化写入)

scripts/              (构建脚本，在 GitHub Actions 内运行)
  compress.js                 (图片→WebP / 视频→HLS)
  generate.js                 (EJS 模板渲染生成静态站)
  upload.js                   (rclone 上传 processed 文件到 R2)

src/                  (前台站点源码)
  layouts/                    (EJS 模板)
  assets/js/                  (gallery.js, video.js, likes.js, app.js)
  assets/css/                 (样式)

functions/            (前台 Pages Functions)
  api/[[path]].js             (代理到 Worker)
```

---

## 4. Worker API 端点

### 4.1 公开端点（无需认证）

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/api/auth/login` | 登录获取 JWT |
| GET | `/api/health` | 健康检查（含版本号） |
| GET | `/api/health/github` | GitHub 真实连通性探测（latency/httpStatus） |
| GET | `/api/health/r2` | R2 真实连通性探测（latency） |
| GET | `/api/stats/traffic` | 流量统计（读取 R2 stats.json） |
| POST | `/api/track/view/:slug` | 浏览计数+1（IP 去重 10min） |
| GET | `/api/stats/:slug` | 单篇实时统计（views/likes/dwell） |
| POST | `/api/track/dwell/:slug` | 停留时长上报（上限 7200s） |
| POST | `/api/track/like/:slug` | 点赞/取消点赞 |
| GET | `/api/media/file/:slug/:filename` | 文件服务（向后兼容） |

> 注：`POST /api/upload/direct/:slug/:filename`（直接上传到 R2）配置了 ADMIN_PASSWORD 时实际需要 JWT，见下方"需认证端点"。

### 4.2 需认证端点

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/posts` | 文章列表 |
| GET | `/api/posts/:slug` | 单篇文章详情 |
| POST | `/api/posts` | 新建文章 |
| POST | `/api/posts/:slug/duplicate` | 复制文章 |
| DELETE | `/api/posts/:slug` | 删除文章（含 R2 媒体） |
| POST | `/api/upload/direct/:slug/:filename` | 直接上传到 R2（需 JWT，2GB 上限） |
| DELETE | `/api/media/:slug/:file` | 删除单个媒体文件（originals+processed） |
| PUT | `/api/taxonomy/category` | 分类重命名（逐篇改写 frontmatter） |
| PUT | `/api/taxonomy/tag` | 标签重命名 |
| GET | `/api/config` | 读取配置 |
| PUT | `/api/config` | 更新配置（深合并，不丢嵌套字段） |
| POST | `/api/build` | 触发 GitHub Actions 构建 |
| GET | `/api/build/status` | 最新构建状态 |
| GET | `/api/build/history` | 构建历史（最近 10 次） |
| GET | `/api/media/:slug/list` | 文章媒体文件列表 |
| GET | `/api/taxonomy` | 分类/标签统计 |
| GET | `/api/stats` | 站点统计（文章数/分类数/标签数） |
| GET | `/api/disk` | R2 存储用量 |
| GET | `/api/cleanup` | 扫描孤儿文件 |
| DELETE | `/api/cleanup` | 删除孤儿文件 |
| DELETE | `/api/processed-cache` | 清空 processed/ 缓存 |
| GET | `/api/dirty` | 查询未构建变更 |
| GET | `/api/trash` | 回收站（stub，GitHub 无原生回收站） |

### 4.3 缓存机制

Worker 内存缓存 Github API 响应：
- `listPosts()`：60 秒 TTL
- `getConfig()`：120 秒 TTL
- 写操作（创建/更新/删除/配置修改）自动清缓存

### 4.4 脏标记（Dirty State）

- 存储：R2 `site-data/dirty.json` + Worker 内存
- 写操作自动标记为脏，构建触发后自动清除
- 所有 API 响应带 `X-Dirty` 头，前端据此显示横幅

---

## 5. Admin 面板

### 5.1 技术栈
- 纯 Vanilla JS SPA（无 React/Vue）
- Remixicon 图标（从 CDN 加载）
- Chart.js 图表
- Hash 路由：`#dashboard` `#posts` `#editor` `#build` `#config` `#taxonomy` `#cleanup`

### 5.2 i18n 系统
- 词典：`I18N` 常量，包含 `zh-CN`/`en` 全部 UI 文本
- 函数：`t(path, vars)` 读取翻译，支持 `{key}` 变量替换
- 存储：`localStorage.mosaic_admin_lang`
- 静态 HTML：使用 `data-i18n` 属性，`init()` 时自动替换
- 动态内容：模板字面量内用 `${t('key')}`
- 切换：Config 页面有下拉框，`setLang()` 触发重渲染

### 5.3 骨架屏
- 6 个页面都有骨架屏：dashboard/posts/editor/build/config/cleanup
- Shimmer 动画：灰色占位块 + 高光流动
- `renderPage()` 先显示 `pages[page].skeleton()`，等待 API 数据返回后替换

### 5.4 API 超时
- `quick(promise, fallback, ms)` 超时保护，默认 15 秒
- 超时数据用 `...` 占位，表示"加载中"
- 不阻塞页面渲染

### 5.5 脏横幅（Dirty Banner）
- 触发条件：Worker 返回 `X-Dirty` 头或 `GET /api/dirty` 返回 count > 0
- 显示：固定黄色横条在侧边栏+内容区上方
- 内容：`"N 项未构建的更改，最后修改 Xm ago。点击此处前往构建 →"`
- 点击跳转 `#build` 页面
- 消失：触发构建后 Worker 清 dirty，前端 `hideDirtyBanner()`

### 5.6 配置页面（Config）
- 7 个分类卡片，CSS Columns 瀑布流布局
- 字段类型：文本框、数字、下拉框、开关、文本域
- 图片画质参数：480p/720p/1080p 独立配置
- 视频参数：CRF + preset
- 域名配置：`url` / `apiBase` / `mediaBase` 全部可后台编辑
- Favicon：图片预览 + 上传按钮 + 100KB 限制

### 5.7 构建页面（Build）
- 最新构建状态卡：状态指示灯 + 耗时显示
- 进行中："已耗时" 每秒跳动（前端 `Date.now() - startTime`）
- 已完成："用时" 显示 `createdAt → updatedAt` 差值
- 历史列表：每次构建的耗时、commit、分支
- 5 秒轮询更新进行中的构建

### 5.8 清理页面（Cleanup）
- 孤儿文件清理：扫描 + 假进度条 + 删除
- 缓存清理：`DELETE /api/processed-cache` 清空 processed/
- 成功后显示绿色确认消息，2 秒自动消失

### 5.9 v0.9 体验与视觉优化（2026-08）
- **结构**：`admin.js` 拆分为 ES 模块（`js/admin.js` 入口 + `i18n/theme/state/ui/upload` + 每页一个模块），仍为零构建 Vanilla JS。
- **设计系统**：`css/admin.css` 重写，含语义色令牌、三态主题（auto/light/dark，`localStorage.mosaic_admin_theme`）、分层阴影、统一圆角/动效，支持 `prefers-reduced-motion`。
- **信息架构**：新增 56px 顶栏（全局搜索、主题/语言切换、构建状态点、一键构建、访问站点）；侧边栏分组（内容/站点/数据），**回收站入口**上线，Deploy 页保留为隐藏重定向。
- **交互**：命令面板（Ctrl/Cmd+K）、快捷键（`n` 新建、`Ctrl+Enter` 保存）、编辑器自动保存草稿（`localStorage.mosaic_draft_*`）+ 离开拦截、Markdown 预览（自托管 `marked.min.js` + `purify.min.js`）、封面选择弹窗、上传并发 2 + 重试/取消/缩略图、危险操作输入确认、删除分类/标签的 Modal 化。
- **性能**：Chart.js 改为仪表盘内懒加载；文章列表超 100 篇分块渲染；图标按钮全部带 aria-label。
- **构建页**：新增概览卡（近 10 次成功率 / 平均时长 / 当前分支）；pipeline 进度条按步骤真实耗时加权（后端返回每步 `startedAt/completedAt`），显示百分比与预计剩余时间（ETA），可展开 22 步明细（每步状态+耗时）；失败时高亮失败步骤并提供「查看日志」跳转；构建结束 Toast + 标题通知；轮询按阶段调速（queued 10s / running 5s）并显示「上次更新」；触发按钮构建中禁用；历史 SHA 可点击跳 commit，支持「在 GitHub 查看全部」。
- **新增 Worker 端点**：`DELETE /api/taxonomy/category|tag`（从所有文章中移除，返回 affected 数）；`GET /api/stats/posts`（批量文章统计，60s 缓存）；`GET /api/posts?limit&cursor`（分页参数，向后兼容）。前端对未部署端点自动降级（隐藏删除入口）。

---

## 6. 前台功能

### 6.1 图片画廊（gallery.js）
- 4 档画质：低清(480p) / 中清(720p) / 高清(1080p) / 原图(orig)
- 键盘切换：`1`=480p `2`=720p `3`=1080p `4`=原图
- 底部胶片导航条
- LQIP 模糊→清晰加载
- 鼠标滚轮缩放

### 6.2 HLS 视频播放器（video.js）
- 自定义播放控件：播放/暂停、进度条、音量、倍速、画质
- 键盘快捷键：空格=播放、←/→=5s 跳跃、↑/↓=音量、f=全屏、n=下一个
- 画质指示器：点击时间戳复制
- 输入法检测防误触

### 6.3 点赞/浏览（likes.js）
- 乐观 UI：点击立即更新，后台同步到 Worker
- 浏览追踪：页面加载自动 POST view（sessionStorage 防重复）
- localStorage 记录已点赞文章
- 服务端存储在 R2 `site-data/stats.json`

### 6.4 LQIP 渐进加载
- 150px 宽缩略图 → 大图，CSS blur→sharp 过渡
- 封面用 `cover-10p.webp`（< 2KB）
- 图片用 `{base}-10p.webp`

### 6.5 封面展示
- 卡片封面 aspect ratio 截断：`coverAspect > 1.5` 时强制 1.5
- srcset 多分辨率：480w / 720w / 1080w

---

## 7. 构建与部署

### 7.1 Pipeline 流程（pipeline.yml）
1. checkout 代码，恢复媒体 checksums 缓存（actions/cache）
2. 安装 ffmpeg + rclone + sharp + exiftool
3. 配置 rclone（R2 S3 凭证），同步 originals → `content/posts/`
4. `exiftool` 剥离原图 EXIF（隐私）
5. `node scripts/compress.js` — 图片 WebP / 视频 HLS+MP4 / 音乐 128k-320k
6. `node tests/worker-smoke.mjs` + `node --check` — 测试
7. `node scripts/generate.js` — 生成 HTML + RSS/Sitemap
8. `node scripts/upload.js` — rclone 上传 processed（`--checksum`）
9. 剥离后的 originals 回传 R2（EXIF-free）
10. 删除 `dist/posts/*/media/`（避免超 Pages 25MB 限制）
11. `wrangler pages deploy dist/` — 部署前台

### 7.2 媒体压缩（compress.js）
- 图片：sharp → WebP，1080p(85%) / 720p(80%) / 480p(75%)
- LQIP：150px 宽缩略图，quality 30
- 视频：ffmpeg → HLS + MP4，4K/1080p/720p/480p/360p
- 音乐：ffmpeg → MP3 128k/320k
- 源文件低于某分辨率自动跳过更高清晰度
- MD5 checksum 增量处理（`dist/.media-checksums.json`，CI 用 actions/cache 缓存；仅当"checksum 未变 **且产物已存在**"才跳过，避免缓存恢复后丢产物）

### 7.3 静态站点生成（generate.js）
- 解析 `content/posts/{slug}/index.md`（gray-matter + marked）
- EJS 模板渲染 index + post + archive + search 页面
- 媒体 URL 生成：优先 `R2_PUBLIC_URL` env，其次 `config.mediaBase`
- `pUrl(slug, folder, filename)` → `{R2_PUBLIC}/processed/{slug}/{folder}/{filename}`
- `oUrl(slug, folder, filename)` → `{R2_PUBLIC}/originals/{slug}/{folder}/{filename}`

### 7.4 环境变量
| 变量 | 用途 | 设置位置 |
|------|------|---------|
| `R2_PUBLIC_URL` | 媒体直连域名（可选，config.mediaBase 也可） | pipeline.yml |
| `R2_ACCESS_KEY` | R2 S3 访问密钥 | GitHub Secrets |
| `R2_SECRET_KEY` | R2 S3 密钥 | GitHub Secrets |
| `R2_ENDPOINT` | R2 S3 端点 | GitHub Secrets |
| `GITHUB_TOKEN` | GitHub API 令牌（触发 workflow_dispatch 需 actions:write） | Worker Secrets |
| `JWT_SECRET` | JWT 签名密钥 | Worker Secrets |
| `ADMIN_PASSWORD` | 管理员密码 | Worker Secrets |
| `CF_ACCOUNT_ID` | Cloudflare 账户 ID | Worker Secrets |
| `CLOUDFLARE_API_TOKEN` | CF API 令牌 | GitHub Secrets |
| `PROXY_SECRET` | Pages Functions → Worker 的 IP 透传签名（Worker Secret + 两个 Pages 项目 Secret） | 部署时设置 |
| `DEV_MODE` | 本地开发：未配置 ADMIN_PASSWORD 时显式允许无鉴权 | Worker（可选） |
| `VIDEO_CACHE_CONTROL` | 视频上传器缓存头（默认 no-store；配 CORS Transform Rule 后改 max-age 恢复边缘缓存） | CI（可选） |

---

## 8. Worker 部署

```bash
cd worker
npx wrangler deploy
```

Admin 部署：
```bash
cd cloud-admin
npx wrangler pages deploy . --project-name mosaic-admin --branch main
```

---

## 9. 已知架构决策

1. **R2 直连不用 Worker 代理**：媒体文件直接走 `mosaic-media.xsanye.cn`，Worker `serveMediaFile` 仅向后兼容
2. **Admin 同源 API 代理**：`functions/api/[[path]].js` 把 `/api/*` 转发到 Worker，消除 CORS 预检
3. **Worker 内存缓存**：零成本，冷启动从 GitHub 重取
4. **服务端脏标记**：R2 持久化 + Worker 内存常驻，换机器不丢
5. **前台 /api 也走 Pages Functions 代理**：绕过 `workers.dev` 被墙
6. **媒体走 pipeline，不手动上传**：所有压缩/转码在 GitHub Actions 完成
7. **Stats Durable Object**：视图/点赞/停留计数单实例串行化写入，杜绝并发丢失；DO 存储为主，R2 stats.json 备份并迁移历史
8. **代理 IP 透传**：Pages Functions 转发真实访客 IP（`X-Real-IP`）并用 `PROXY_SECRET` 签名，Worker 校验后才信任——修复视图去重与登录限流
9. **媒体缓存与 CORS**：视频对象默认 `Cache-Control: no-store` 换取 CORS 确定性；配置媒体域 Transform Rule 后可改回 `public, max-age` 恢复边缘缓存
10. **增量构建**：checksum 缓存 + 产物清单（v2）——内容未变时压缩秒级跳过，generate 仍按清单输出 HLS/封面

---

## 10. 文件清单

```
.
├── mosaic.config.json          # 站点配置（可在后台编辑）
├── .github/workflows/pipeline.yml  # CI/CD
├── scripts/
│   ├── compress.js             # 媒体压缩
│   ├── generate.js             # 站点生成
│   └── upload.js               # R2 上传
├── worker/
│   ├── wrangler.toml
│   └── src/
│       ├── index.js            # Hono 路由
│       ├── github.js           # GitHub API + 缓存 + 脏标记
│       ├── r2.js               # R2 操作
│       ├── shared.js           # 常量/CORS/StatsDO/R2 遍历工具
│       ├── routes/             # health/stats/media/posts/build/config/taxonomy/admin
│       ├── auth.js             # JWT 认证 + 登录/track 限流 + IP 校验
│       └── stats-do.js         # Stats Durable Object
├── cloud-admin/
│   ├── index.html              # SPA 入口
│   ├── js/                       # ES 模块（admin.js 入口 + 每页模块）
│   ├── css/admin.css           # 样式
│   ├── src/api.js              # API 封装
│   └── functions/api/[[path]].js  # Pages 代理（IP 透传）
├── src/
│   ├── layouts/                # EJS 模板
│   │   ├── index.ejs           # 首页列表
│   │   └── post.ejs            # 文章页
│   └── assets/
│       ├── js/
│       │   ├── app.js          # 前端入口
│       │   ├── gallery.js      # 图片画廊
│       │   ├── video.js        # 视频播放器
│       │   ├── likes.js        # 点赞/浏览
│       │   ├── stats.js        # 停留时间
│       │   └── utils.js        # 工具函数
│       └── css/                # 前台样式
├── functions/api/[[path]].js   # 前台 Pages 代理（IP 透传）
├── content/posts/              # 文章 Markdown（Git 管理）
├── tests/                      # check-site.mjs / frontend.spec.js / worker-smoke.mjs / admin-smoke.mjs
└── dist/                       # 构建输出（gitignore）
```

> 本地 `admin/`（Express 面板）已移除，管理功能全部由 `cloud-admin/` 承担。

---

## 11. 待办 / 已知问题

### 功能
- [x] EXIF 隐私抹除（pipeline 用 exiftool 剥离 originals）
- [x] 图片放大切换清晰度后保留 zoom（gallery.js）
- [x] 移动端 HLS 兼容性测试（Playwright 移动视口 + HLS 起播已入 CI；真机矩阵见 README 路线图）
- [x] 音乐播放器（列表播放已接线，封面/波形待补）

### 优化
- [x] Worker disk/cleanup 并行遍历 + disk 60s 缓存
- [x] 统计并发：Stats Durable Object（R2 stats.json 自动迁移）
- [x] Admin 资源自托管（remixicon.css + woff2 随 cloud-admin 同源部署，无 CDN）
- [x] Admin 前端拆分（v0.9 起 ES 模块化：入口 + i18n/theme/state/ui/upload + 每页模块）
- [ ] 构建页面合并 options/status/history 为一个视图

### 部署
- [x] `mosaic-admin.xsanye.cn` 自定义域名绑定到 Pages 项目（admin-smoke 实测可登录）
- [x] R2 CORS 已配置（允许 * GET/PUT），确认无误
