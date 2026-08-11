# Mosaic 媒体指南

## 概览

Mosaic 把媒体与内容分离：Markdown 文本进 Git，二进制媒体进 Cloudflare R2。媒体**永远不手动本地传输**——完整链路是：Admin 上传 → R2 `originals/` → GitHub Actions 压缩 → R2 `processed/` → 前台展示。

## 媒体如何进入平台

1. 在 Admin 编辑器打开文章，把文件拖入上传区
2. 浏览器向 Worker 请求预签名 URL（`POST /api/upload/presign`），随后**直连 R2** 上传（单文件最大 5GB），完成后调 `POST /api/upload/complete` 标记待构建；**超过 100MB 的大文件自动走分片上传**（`/api/upload/multipart/*`，默认每片 100MB、3 并发、每片重试 3 次），断线/刷新后重试会从已上传分片继续，无需从头传
3. 在构建中心点击"构建并部署"，管线从 `originals/` 拉取并压缩

> 禁止用 Playwright / curl / 脚本手动上传到 R2 绕过管线；管线故障应从根源修复。

## 目录结构

```
content/posts/{slug}/
├── index.md          # 必填
├── cover.jpg         # 可选封面
├── photos/           # 可选：画廊图片
├── videos/           # 可选：视频
└── music/            # 可选：音频（见 music-guide.md）
```

## 内容编排（blocks）

文章正文与媒体按**内容块**顺序渲染：

- 默认顺序：`正文 → 画廊 → 视频 → 音乐`
- `layout: gallery-first` / `video-first` 把对应媒体块移到最前（旧写法，兼容保留）

正文中可用占位符自由混排（占位符必须**单独成行**，前后空行）：

```markdown
开头文字……

{{gallery}}

接着写正文，中间插入单张图：

{{photo:0}}

再放第一个视频：

{{video:0}}

结尾放全部视频与音乐：

{{videos}}
{{music}}
```

- `{{gallery}}`：画廊全部图片；`{{videos}}`：全部视频（stacked/playlist 由 `video_mode` 决定）；`{{music}}`：音乐列表
- `{{photo:N}}` / `{{video:N}}`：渲染第 N 张图 / 第 N 个视频（从 0 计数）为单块
- 未被占位符引用的媒体类型自动追加到末尾（不丢失、不重复）；越界引用（如 `{{video:9}}`）保持原样显示，便于发现
- 有占位符时以占位符顺序为准；无占位符时也可用 frontmatter `blocks: [music, text, gallery, videos]` 显式排序

文章类型 `post.type`（`text / gallery / video / music / mixed`）由内容块自动推导，用于 SEO 与数据。

## 图片

### 支持格式

JPEG（`.jpg`/`.jpeg`）、PNG（`.png`）、WebP（`.webp`）、TIFF（`.tiff`）。

### 处理

- 自动转 WebP 三档：**480p / 720p / 1080p**（宽），另生成 150px **LQIP** 占位图（`*-10p.webp`）
- 管线自动**剥离原图 EXIF**（含 GPS），隐私默认受保护
- `srcset` 按视口加载对应档位

### 画廊

- 网格（masonry）与单列大图（≤ `gallerySingleThreshold` 张时）两种模式
- 全屏查看器：左右键 / 滚轮缩放 / 捏合 / 底部胶片导航
- 清晰度切换：`1`=480p、`2`=720p、`3`=1080p、`4`=原图；切换时保留缩放状态

## 视频

### 支持格式

MP4（推荐）、MOV、AVI、MKV、WebM。

### 处理

- FFmpeg 转码 HLS（m3u8 + ts 分片）与多分辨率 MP4：**240p–1080p**（默认顶格 1080p；在 Admin 配置或 `videoQuality.maxHeight` 中可开启 4K）
- 低分辨率源（如 240p 素材）自动走最低档，不会强转更高清晰度
- 自动提取 1 秒处海报帧（`*-poster.jpg`）

### 播放器

- HLS 自适应码率（ABR），质量菜单支持 **Auto / 手动选档**，切换无缝
- 倍速、音量、PiP、全屏、播放列表（`video_mode: playlist`）
- 快捷键：空格=播放/暂停、`←/→`=±5s、`↑/↓`=音量、`f`=全屏、`n`=下一个
- 网络波动自动重试与致命错误自动恢复

## 封面

1. 显式指定：`cover: cover.jpg`（或 `cover.png`/`cover.webp`）
2. 引用媒体：`cover: video:0`（第 1 个视频的海报帧）或 `cover: photo:0`（第 1 张照片的 480p 档）
3. 自动检测：视频海报帧 → 首张照片

封面尊重原图宽高比（`coverAspectMin/Max` 约束），卡片展示时超过 1.5 会统一裁切为 1.5。

## 最佳实践

- 图片用 JPEG、视频用 MP4、音频用 FLAC/MP3
- 文件名避免空格与特殊字符（压缩产物按净化后的 base 命名）
- 图片宽度控制在 4000px 内、视频 4K/30fps 内，以缩短管线转码时间
- 已有内容更新：同名重传即可，管线按 checksum 增量处理
