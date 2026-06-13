# Mosaic v0.8 Architecture

## Overview

Mosaic is a pure static multimedia site generator for personal creators. v0.8 introduces a cloud-native architecture that separates content management, media storage, compute, display, and administration into distinct layers.

```
 ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
 │  GitHub Repo  │    │  Cloudflare   │    │  Cloudflare   │
 │  (Content)    │    │  R2 (Media)   │    │  Pages (Site) │
 │               │    │               │    │               │
 │  • Markdown   │    │  • Originals  │    │  • HTML       │
 │  • Config     │    │  • Processed  │    │  • CSS        │
 │  • Templates  │    │  • Thumbs     │    │  • JS         │
 │  • Indexes    │    │  • HLS        │    │  • Data JSON  │
 └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
        │                   │                   │
        │    ┌──────────────┴──────────────┐    │
        └────►    GitHub Actions (Build)   ◄────┘
             │                              │
             │  • Parse Markdown            │
             │  • Compress Images (sharp)   │
             │  • Transcode Videos (FFmpeg) │
             │  • Extract Music Meta        │
             │  • Render HTML (EJS)         │
             │  • Generate RSS/Sitemap      │
             └──────────────────────────────┘
                          │
                   ┌──────┴───────┐
                   │  Worker API  │
                   │  (Backend)   │
                   │              │
                   │  • Auth      │
                   │  • Upload    │
                   │  • Publish   │
                   │  • Status    │
                   └──────┬───────┘
                          │
                   ┌──────┴───────┐
                   │  Cloud Admin │
                   │  (Frontend)  │
                   └──────────────┘
```

## Layers

### 1. Git Repository (Content)
Stores only text-based content:
- `content/posts/{slug}/index.md` — Markdown posts with YAML frontmatter
- `mosaic.config.json` — Site configuration
- `src/layouts/` — EJS templates
- `src/assets/css/` and `src/assets/js/` — Static assets
- `src/data/i18n.json` — Internationalization strings
- `themes/` — Theme definitions
- `scripts/` — Build scripts

**Does NOT store** image, video, or audio files.

### 2. Cloudflare R2 (Media)
Unified object storage:
- `originals/{slug}/photos/` — Original uploaded images
- `originals/{slug}/videos/` — Original uploaded videos
- `originals/{slug}/music/` — Original audio files
- `processed/{slug}/photos/` — Compressed WebP variants (480p/720p/1080p)
- `processed/{slug}/videos/` — Transcoded MP4 + HLS segments
- `processed/{slug}/music/` — Transcoded MP3 (128k/320k)
- `processed/{slug}/covers/` — Cover image variants
- `site-data/` — Build artifacts (search index, posts JSON)

### 3. GitHub Actions (Compute)
Build pipeline executed on push or manual trigger:
1. Clone repo
2. Sync media from R2 to temporary directory
3. Compress images via sharp
4. Transcode videos via FFmpeg
5. Extract music metadata
6. Render static HTML pages
7. Upload processed media back to R2
8. Deploy to Cloudflare Pages
9. Upload search index to R2

### 4. Cloudflare Pages (Display)
Static hosting for the generated site:
- HTML pages with inline CSS/JS
- JSON data files for client-side search
- Atom feed and Sitemap
- All media references point to R2 public URLs

### 5. Worker API (Backend)
REST API at `api.example.com`:
- JWT-based authentication
- R2 presigned URL generation for direct uploads
- GitHub Actions trigger via repository_dispatch
- Build status querying
- Media file management

### 6. Cloud Admin (Management UI)
Browser-based management panel at `admin.example.com`:
- Dashboard with stats
- Post CRUD with Markdown editor
- Drag-and-drop media upload (direct to R2)
- One-click build and deploy
- Configuration editor
- Category/tag management
- Trash with recovery

## Data Flow

### Publishing Flow
```
Creator → Cloud Admin → Worker API → GitHub Actions → Pages
                    → R2 (media upload)
                                   → R2 (processed media)
                                              → Pages (HTML/CSS/JS)
```

### Build Flow
```
Git Push → GitHub Actions
  ├─ rclone pull from R2
  ├─ sharp (images)
  ├─ ffmpeg (videos)
  ├─ music-metadata (audio)
  ├─ generate-data.js (Markdown → JSON)
  ├─ generate-pages.js (JSON + EJS → HTML)
  ├─ rclone push to R2
  └─ pages-action deploy
```

## Post Content Model

```yaml
---
title: "My Post"
date: 2026-06-01
category: travel
tags: [europe, summer]
description: "A trip through Europe"
cover: cover.jpg        # or video:0, photo:0
layout: default         # default | video-first | gallery-first | music-first
video_mode: stacked     # stacked | playlist
views: 1200
likes: 45
dwell_time: 320
---

Markdown content here.
```

### Media Types
- **article**: Markdown text content
- **photo**: Images in `photos/` directory
- **video**: Videos in `videos/` directory
- **music**: Audio files in `music/` directory (with metadata from `music-meta.json`)

## Configuration

See `mosaic.config.json` for all settings. Key v0.8 additions:
- `musicQuality` — MP3 transcode settings
- `enableMusicProcessing` — Toggle music feature
- `theme` — Active theme name
- `themeOverrides` — Token-level theme customization
- `worker.apiUrl` — Worker API endpoint
- `mediaSource.publicUrl` — R2 public URL for media references
