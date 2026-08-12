# Mosaic 配置参考

站点配置集中在根目录 `mosaic.config.json`，可以在 Admin → 站点设置中可视化编辑（保存为深合并，不会丢字段）。以下字段以当前代码为准。

## 站点

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `title` | string | `"Mosaic"` | 站点名称 |
| `subtitle` | string | `""` | 副标题 |
| `description` | string | `""` | SEO 描述 |
| `url` | string | `""` | 站点绝对地址（RSS/Sitemap/OG 用） |
| `apiBase` | string | `""` | Worker API 地址（前台 track 上报用） |
| `mediaBase` | string | `""` | R2 媒体直连域名 |
| `language` | string | `"zh-CN"` | 界面语言（`zh-CN`/`en`） |
| `author.name` / `author.email` | string | `""` | RSS 作者信息 |
| `dateFormat` | string | `"YYYY-MM-DD"` | 日期格式 |
| `favicon` | string | `"/assets/logo.svg"` | 站点图标（可后台上传到 `site-data/favicon.*`） |
| `headerNav` | array | `[]` | 自定义导航 `[{ "label": "...", "url": "..." }]` |
| `footerText` | string | `""` | 自定义页脚文字 |

## 布局与卡片

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `pageSize` | number | `50` | 首页每页文章数 |
| `gallerySingleThreshold` | number | `5` | 少于等于该数量时画廊单列大图 |
| `coverAspectMin` / `coverAspectMax` | number | `0.5625` / `999` | 封面宽高比限制 |
| `cardShowTags` / `cardShowStats` | boolean | `true` | 卡片显示标签 / 统计 |
| `searchMinChars` | number | `2` | 触发搜索的最少字符 |

## 媒体处理

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `imageQuality` | object | `{"480p":75,"720p":80,"1080p":85}` | WebP 画质 |
| `videoQuality.crf` | number | `23` | FFmpeg CRF（越小画质越好体积越大） |
| `videoQuality.preset` | string | `"veryfast"` | FFmpeg preset（越快耗时越短） |
| `videoQuality.maxHeight` | number | `1080` | 转码顶格档位（2160=4K、1080=1080p…） |
| `videoQuality.uploadAfterTiers` | number | `1` | 每转完 n 个清晰度上传一批（1=每档即传，5=全部完成再传） |
| `enableVideoCompression` | boolean | `true` | 视频转码总开关 |
| `enableBusuanzi` | boolean | `true` | 不蒜子第三方计数（与 Mosaic 实时统计并存显示） |

音乐固定转码 MP3 128k/320k，无需额外配置。

## 构建

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `build.timeoutMinutes` | number | `90` | 单次构建超时（10–360）。后台触发生效；push 自动构建固定 90 |

视频转码按档位升序（240p→4K）边转边传，并带断点续传与时间预算保护（85% 超时后跳过剩余高档位，下次构建续传补齐），详见 [operations.md](operations.md)。

## 媒体源

| 字段 | 说明 |
| --- | --- |
| `mediaSource.type` | `"r2"` |
| `mediaSource.bucket` | R2 桶名（`mosaic-media`） |
| `mediaSource.endpoint` | R2 S3 端点（GitHub Secrets 提供，可留空） |

## 主题

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `theme` | string | `"auto"` | `auto`/`light`/`dark` |

主题令牌由 `themes/default/theme.json` 定义。

## 插件

| 插件 | 说明 |
| --- | --- |
| `compress-images` | sharp WebP 压缩 |
| `compress-videos` | FFmpeg 视频转码 |
| `generate-feed` | RSS/Atom 生成 |
| `generate-sitemap` | Sitemap 生成 |

设置 `"enabled": false` 可关闭。

## 组件

| 组件 | 说明 |
| --- | --- |
| `gallery` | 图片画廊（缩放/懒加载） |
| `video` | HLS 视频播放器 |
| `comments` | Giscus 评论（需配置 giscus 字段） |
| `search` | 前端全文搜索 |
| `likes` | 点赞按钮 |
| `stats` | 浏览/停留统计 |

音乐播放器默认启用，不在 `components` 中开关。

## 评论（Giscus）

`giscus.repo` / `giscus.repoId` / `giscus.category` / `giscus.categoryId`，并在 `components.comments.enabled` 置 `true`。

## 环境变量

### GitHub Actions Secrets（仓库 Settings → Secrets）

| 变量 | 用途 |
| --- | --- |
| `R2_ACCESS_KEY` / `R2_SECRET_KEY` / `R2_ENDPOINT` | rclone / SDK 访问 R2 |
| `CLOUDFLARE_API_TOKEN` | 部署 Pages |
| `CLOUDFLARE_ACCOUNT_ID` | CF 账户 ID |

### Worker Secrets（`wrangler secret put`）

| 变量 | 用途 |
| --- | --- |
| `ADMIN_PASSWORD` | 管理员密码（登录） |
| `JWT_SECRET` | JWT 签名密钥（必填，缺失即 fail-closed） |
| `GITHUB_TOKEN` | GitHub API 令牌（Contents + Actions 写权限） |
| `CF_ACCOUNT_ID` | CF 账户 ID（预签名 URL 用） |
| `R2_ACCESS_KEY` / `R2_SECRET_KEY` | R2 S3 凭证（预签名用） |
| `PROXY_SECRET` | Pages→Worker IP 透传签名（与两个 Pages 项目 Secret 一致） |

### 可选

| 变量 | 位置 | 说明 |
| --- | --- | --- |
| `DEV_MODE` | Worker | 未配置 ADMIN_PASSWORD 时显式允许无鉴权（仅本地开发） |
| `VIDEO_CACHE_CONTROL` | CI | 视频上传器的缓存头（当前 `public, max-age=86400`；CORS Transform Rule 已生效，1 天保守 TTL，稳定后可拉长） |
| `CHECKSUMS_FILE` | 构建 | 覆盖媒体 checksum 文件路径（默认 `dist/.media-checksums.json`） |
| `R2_PUBLIC_URL` | 构建 | 覆盖媒体直连域名（可选，默认取 `config.mediaBase`） |

## 文章 frontmatter

```yaml
---
title: "标题"               # 必填
date: 2026-05-01            # 必填
category: travel            # 默认 uncategorized，支持 photography/nature 多级
tags: [landscape, travel]   # 标签数组
description: "摘要"          # 缺省从正文截取
cover: cover.jpg            # 封面文件名，或 video:N / photo:N（媒体索引），留空自动检测（视频截帧 > 首张照片）
video_mode: stacked         # stacked | playlist
blocks: []                  # 可选：显式块顺序 [text, gallery, videos, music]（正文含占位符时以占位符为准）
---
```

`views` / `likes` / `dwell_time` 为兼容遗留字段，仅作静态兜底；实时统计以 Durable Object 为准。
