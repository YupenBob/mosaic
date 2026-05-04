<p align="center">
  <img src="src/assets/logo.svg" alt="Mosaic" width="80" />
</p>

<h1 align="center">Mosaic</h1>
<p align="center"><em>拼图成画</em></p>

<p align="center">
  纯静态多媒体站点生成器。<br/>
  像 Hexo，但专为<strong>照片和视频</strong>而生。
</p>

<p align="center">
  <strong>Markdown 写进去，漂亮站点吐出来。零后端。</strong>
</p>

---

## 为什么选 Mosaic

大多数静态站点生成器把图片当作附属品。Mosaic 把<strong>照片和视频放在核心位置</strong>——响应式图库、懒加载、沉浸式全屏浏览、底部缩略条导航、双指缩放、清晰度切换、自定义视频播放器支持多分辨率。一切只需要把 Markdown 文件丢进文件夹。

## 快速开始

```bash
git clone https://github.com/YupenBob/mosaic.git
cd mosaic
npm install
npm run demo          # 生成示例内容
npm run build         # 构建站点
npx serve dist        # 预览 http://localhost:3000
```

## 功能

| 功能 | 说明 |
|------|------|
| **照片图库** | 响应式网格 · 懒加载 · 全屏沉浸浏览 · 底部缩略条导航 · 双指缩放 · 清晰度切换 |
| **视频播放器** | 自定义控件 · 多分辨率 · 倍速播放 · 下载 · 全屏 · 播放列表模式 |
| **智能封面** | 自动检测：视频截帧 > 首张照片 > 显式指定，跟随原图比例 |
| **搜索筛选** | 分类/标签筛选 · 全文搜索 · 关键词高亮 · 瀑布流卡片布局 |
| **暗色模式** | 自动跟随系统偏好，所有组件无缝适配 |
| **响应式** | 手机到桌面全适配，CSS 瀑布流，srcset 自适应图片 |
| **增量构建** | 仅构建变化内容，典型耗时不到 1 秒 |
| **国际化** | 中英文界面，可配置的界面文本 |
| **RSS / Sitemap** | 自动生成 Atom Feed，含 priority/lastmod 的 SEO 优化站点地图 |
| **评论** | Giscus 集成——GitHub Discussions 驱动，零后端 |
| **增量构建** | 默认只重建有变化的内容，0.5 秒典型构建时间 |
| **本地管理面板** | `cd admin && npm start`，可视化编辑帖子、上传媒体、一键构建部署 |

## 写一篇文章

```markdown
---
title: "我的摄影故事"
date: 2026-05-01
category: 摄影
tags: [风光, 旅行]
description: "一场穿越山峦的影像之旅。"
cover: cover.jpg
layout: default          # default | video-first | gallery-first
---

## 第一天

用 Markdown 写下你的故事。照片放进 `photos/`，
视频放进 `videos/`。剩下的交给 Mosaic。
```

## 项目结构

```
content/posts/{slug}/     你的文章——每篇一个目录
  index.md                带 YAML 头信息的 Markdown
  cover.jpg               封面图（可选，支持自动检测）
  photos/                 图库图片（jpg/png/webp）
  videos/                 视频文件（mp4/mov/avi）

src/                      模板、样式、客户端 JS
scripts/                  构建脚本（Node.js）
dist/                     生成的静态站点 → 部署这个目录
mosaic.config.json        全局配置文件
admin/                    本地管理面板
```

## 配置

编辑项目根目录的 `mosaic.config.json`：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `title` | `"Mosaic"` | 站点名称 |
| `url` | — | 站点 URL（RSS、Sitemap、OG 标签用） |
| `language` | `"zh-CN"` | 界面语言 |
| `pageSize` | `50` | 每页显示文章数 |
| `coverAspectMin` | `0.5625` | 封面最小宽高比（9:16） |
| `coverAspectMax` | `999` | 封面最大宽高比（无限制） |
| `gallerySingleThreshold` | `5` | ≤ N 张图用竖排大图模式 |
| `enableVideoCompression` | `false` | 开启 FFmpeg 多分辨率转码 |
| `giscus` | — | 评论区配置 |

## 命令

```bash
npm run build          # 增量构建（默认）
npm run clean          # 全量清理重建
npm run dev            # 监听模式，文件变化自动重建
npm run demo           # 生成演示内容
```

## 部署

推送 `main` 分支，GitHub Actions 自动部署到 **GitHub Pages** 或 **Cloudflare Pages**。

也可以手动上传 `dist/` 到任意静态托管（Vercel、Netlify、Nginx）。

## 管理面板

```bash
cd admin
npm install
npm start              # 打开 http://localhost:4000
```

- 可视化帖子编辑器（Markdown + 实时预览 + 分屏）
- 拖拽上传媒体、进度条
- 一键构建 + 实时日志
- 分类/标签管理、回收站
- Git 提交推送、多平台部署

## 协议

<p align="center">MIT</p>
