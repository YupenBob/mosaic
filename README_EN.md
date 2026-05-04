<p align="center">
  <img src="src/assets/logo.svg" alt="Mosaic" width="80" />
</p>

<h1 align="center">Mosaic</h1>
<p align="center"><em>Pieces Together</em></p>

<p align="center">
  A pure static multimedia site generator.<br/>
  Like Hexo, but built for <strong>photo &amp; video</strong> stories.
</p>

<p align="center">
  <strong>Markdown in. Beautiful static site out. Zero backend.</strong>
</p>

---

## Why Mosaic

Most static site generators treat images as an afterthought. Mosaic puts **photos and videos at the center** — responsive galleries, immersive fullscreen viewer with filmstrip, pinch-to-zoom, quality switching, and a custom video player with multi-resolution support. All from plain Markdown files.

## Quick Start

```bash
git clone https://github.com/YupenBob/mosaic.git
cd mosaic
npm install
npm run demo          # generate demo content
npm run build         # build the site
npx serve dist        # preview at http://localhost:3000
```

## Features

| Feature | Description |
|---------|-------------|
| **Photo Gallery** | Responsive grid · Lazy loading · Fullscreen viewer · Filmstrip · Pinch zoom · Quality switching |
| **Video Player** | Custom controls · Multi-resolution · Speed control · Download · Fullscreen · Playlist mode |
| **Smart Covers** | Auto-detect from video frame, first photo, or explicit file. Original aspect ratio preserved |
| **Search & Filter** | Category/tag filtering · Full-text search · Keyword highlighting · Masonry card layout |
| **Dark Mode** | Auto system preference. All components adapt |
| **Responsive** | Mobile to desktop. CSS masonry columns. srcset adaptive images |
| **Incremental Builds** | Only rebuild what changed. Typical build under 1s |
| **i18n** | Chinese / English UI. Configurable strings |
| **RSS & Sitemap** | Auto Atom feed + SEO sitemap |
| **Comments** | Giscus — GitHub Discussions, zero backend |
| **Admin Panel** | `cd admin && npm start` — visual editor, media uploads, one-click build |

## Writing a Post

```markdown
---
title: "My Photo Story"
date: 2026-05-01
category: photography
tags: [landscape, travel]
description: "A photo journey through the mountains."
cover: cover.jpg
layout: default          # default | video-first | gallery-first
---

## Day One

Write in Markdown. Put photos in `photos/`, videos in `videos/`.
```

## Configuration

Edit `mosaic.config.json`:

| Field | Default | Description |
|-------|---------|-------------|
| `title` | `"Mosaic"` | Site title |
| `url` | — | Base URL for sitemap, RSS, OG |
| `language` | `"zh-CN"` | UI language |
| `pageSize` | `50` | Posts per page |
| `gallerySingleThreshold` | `5` | ≤ N photos → single column |
| `enableVideoCompression` | `false` | FFmpeg transcode |

## Deploy

Push to `main` — GitHub Actions deploys to **GitHub Pages** or **Cloudflare Pages**.

Or upload `dist/` to Vercel, Netlify, Nginx.

## License

<p align="center">MIT</p>
