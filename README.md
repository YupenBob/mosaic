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

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" />
  <img src="https://img.shields.io/badge/static-ssg-4361ee" />
</p>

## Why Mosaic

Most static site generators treat images as an afterthought. Mosaic puts **photos and videos at the center** — responsive galleries with lazy loading, immersive fullscreen viewer with filmstrip navigation, pinch-to-zoom, quality switching, and a custom video player with multi-resolution support. All from plain Markdown files dropped into a folder.

## Quick Start

```bash
git clone https://github.com/example/mosaic.git
cd mosaic
npm install
npm run demo          # generate demo content
npm run build         # build the site
npx serve dist        # preview at http://localhost:3000
```

## Features

<p align="center">
  <table>
    <tr>
      <td width="50%">
        <strong>Photo Gallery</strong><br/>
        Responsive grid &middot; Lazy loading &middot; Fullscreen viewer &middot; Filmstrip navigation &middot; Pinch-to-zoom &middot; Quality switching (480p/720p/1080p)
      </td>
      <td width="50%">
        <strong>Video Player</strong><br/>
        Custom controls &middot; Multi-resolution &middot; Speed control &middot; Download &middot; Fullscreen &middot; Playlist mode
      </td>
    </tr>
    <tr>
      <td>
        <strong>Smart Covers</strong><br/>
        Auto-detect from video poster, first photo, or explicit file. Original aspect ratio preserved.
      </td>
      <td>
        <strong>Filtering &amp; Search</strong><br/>
        Category &amp; tag filtering &middot; Full-text search &middot; Highlighted results &middot; Masonry card layout
      </td>
    </tr>
    <tr>
      <td>
        <strong>Dark Mode</strong><br/>
        Automatic system preference detection. All components adapt seamlessly.
      </td>
      <td>
        <strong>Responsive</strong><br/>
        Mobile to desktop. CSS columns masonry. Adaptive images with srcset.
      </td>
    </tr>
    <tr>
      <td>
        <strong>Incremental Builds</strong><br/>
        Only rebuild what changed. Typical build under 1 second.
      </td>
      <td>
        <strong>i18n</strong><br/>
        Chinese and English UI. Fully configurable interface strings.
      </td>
    </tr>
    <tr>
      <td>
        <strong>RSS &amp; Sitemap</strong><br/>
        Auto-generated Atom feed. SEO-optimized sitemap with priority and lastmod.
      </td>
      <td>
        <strong>Comments</strong><br/>
        Giscus integration — GitHub Discussions powered, zero backend.
      </td>
    </tr>
  </table>
</p>

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

Write your story in Markdown. Drop photos into `photos/`,
videos into `videos/`. Mosaic handles the rest.
```

## Project Structure

```
content/posts/{slug}/     Your posts — one directory each
  index.md                Markdown with YAML front matter
  cover.jpg               Cover image (optional, auto-detected)
  photos/                 Gallery images (jpg/png/webp)
  videos/                 Video files (mp4/mov/avi)

src/                      Templates, stylesheets, client JS
scripts/                  Build pipeline (Node.js)
dist/                     Generated static site → deploy this
mosaic.config.json        Global configuration
```

## Configuration

Edit `mosaic.config.json` at the project root:

| Field | Default | Description |
|-------|---------|-------------|
| `title` | `"Mosaic"` | Site title |
| `url` | — | Base URL for sitemap, RSS, OG tags |
| `language` | `"zh-CN"` | UI language (`zh-CN` or `en`) |
| `pageSize` | `50` | Posts per page |
| `coverAspectMin` | `0.5625` | Min cover ratio (9:16) |
| `coverAspectMax` | `999` | Max cover ratio (unlimited) |
| `gallerySingleThreshold` | `5` | ≤ N photos → single column layout |
| `enableBusuanzi` | `true` | Page view counter |
| `enableVideoCompression` | `false` | FFmpeg multi-resolution transcode |
| `giscus` | — | Comment system config |

## Commands

```bash
npm run build          # incremental build (default)
npm run clean          # full clean rebuild
npm run dev            # watch mode with hot rebuild
npm run demo           # generate placeholder content
```

## Deploy

Push to `main`. GitHub Actions auto-deploy to **GitHub Pages** or **Cloudflare Pages**.

Or manually — upload `dist/` to any static host (Vercel, Netlify, Nginx).

## License

<p align="center">MIT</p>
