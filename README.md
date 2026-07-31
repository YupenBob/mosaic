<p align="center">
  <img src="src/assets/logo.svg" alt="Mosaic" width="80" />
</p>

<h1 align="center">Mosaic</h1>
<p align="center"><em>你的个人B站 —— 不是挂 MP4 的 Hexo 博客</em></p>

<p align="center">
  Markdown 写故事，照片视频做主角。<br/>
  0成本 · 云端管理 · 零运维 · 纯静态。
</p>

<p align="center">
  <a href="https://mosaic.xsanye.cn"><strong>Demo</strong></a>
</p>

---

## 架构

```
Markdown + 媒体 → GitHub Actions → 静态站点 (CF Pages)
                                   │
                    Worker API ────┤
                    (CF Workers)   │
                         │        │
                    R2 Storage ←──┘
                    (媒体存储)
```

- **Git** 管理内容（Markdown + 配置）
- **R2** 存储媒体（图片、视频、音乐原始文件 + 压缩产物）
- **GitHub Actions** 负责计算（压缩转码、生成静态站点）
- **Cloudflare Pages** 托管前端 + 管理面板
- **Cloudflare Workers** 提供 API（认证、上传、构建触发、统计）
- **Cloudflare R2** 存储所有媒体资源

## 快速开始

```bash
git clone https://github.com/YupenBob/mosaic.git
cd mosaic
npm install
npm run compress      # 压缩媒体（本地无媒体可跳过）
npm run build         # 构建站点
npm run serve         # 预览 http://localhost:3000
```

> 完整从零搭建指南见 **[docs/SETUP.md](docs/SETUP.md)**

## 功能

| 功能 | 说明 |
|------|------|
| **照片图库** | 响应式网格 · 全屏浏览 · 缩略条 · 缩放 · 清晰度切换 |
| **视频播放器** | HLS 流 · 多分辨率 · 倍速 · PiP · 播放列表 |
| **智能封面** | 自动检测：视频截帧 > 首张照片 |
| **搜索筛选** | 分类/标签 · 全文搜索 · 瀑布流卡片布局 |
| **暗色模式** | 自动跟随系统 |
| **增量构建** | 仅构建变化内容 |
| **i18n** | 中/英文 |
| **RSS / Sitemap** | 自动生成 |
| **评论** | Giscus（GitHub Discussions 驱动） |
| **云端管理** | 在线编辑器 · 可视化上传 · 一键构建部署 |
| **分析面板** | 浏览量 · Chart.js 图表 · 点赞统计 |

## 写文章

```
content/posts/my-post/
  ├── index.md       # Markdown + YAML frontmatter
  ├── photos/         # 图片
  └── videos/         # 视频
```

```yaml
---
title: "我的摄影故事"
date: 2026-05-01
category: photography/nature    # 支持多级分类
tags: [风光, 旅行]
description: "一场影像之旅。"
cover: cover.jpg
layout: video-first
---
```

## 项目结构

```
├── content/posts/       # 文章（Markdown）
├── scripts/             # 构建脚本
├── src/                 # 模板 + 前端资源
├── worker/              # Cloudflare Worker API
├── cloud-admin/         # 云端管理面板
├── admin/               # 本地管理面板（开发用）
├── mosaic.config.json   # 站点配置
└── docs/                # 文档
```

## 部署

1. 配置 Cloudflare（R2 + Pages + Workers）
2. 部署 Worker API
3. 部署管理面板
4. 设置 GitHub Actions Secrets
5. Push → 自动构建部署

详见 **[docs/SETUP.md](docs/SETUP.md)**

## 协议

MIT
