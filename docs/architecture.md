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
2. Restore media checksums cache (actions/cache)
3. Sync originals from R2; strip EXIF via exiftool
4. Compress images (sharp WebP) / transcode videos (FFmpeg HLS+MP4) / music (MP3 128k/320k)
5. Run tests (`node tests/worker-smoke.mjs`, `node --check`)
6. Render static HTML + RSS/Sitemap (`scripts/generate.js`)
7. Upload processed media to R2 (`--checksum`); sync EXIF-free originals back
8. Strip `dist/posts/*/media/`, deploy to Cloudflare Pages

### 4. Cloudflare Pages (Display)
Static hosting for the generated site:
- HTML pages with inline CSS/JS
- JSON data files for client-side search
- Atom feed and Sitemap
- All media references point to R2 public URLs

### 5. Worker API (Backend)
REST API at `api.example.com`:
- JWT-based authentication
- R2 direct uploads (2GB cap, content-type allowlist)
- GitHub Actions trigger via workflow_dispatch (push-trigger fallback)
- Build status querying
- Media file management (list/delete)
- Stats via Durable Object (race-free view/like/dwell counters)
- Real visitor IP via Pages Functions proxy (`X-Real-IP` signed with `PROXY_SECRET`)

### 6. Cloud Admin (Management UI)
Browser-based management panel at `admin.example.com`:
- Dashboard with stats
- Post CRUD with Markdown editor
- Drag-and-drop media upload (direct to R2)
- One-click build and deploy
- Configuration editor
- Category/tag management
- Orphan-file cleanup and processed-cache clearing

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
  ├─ actions/cache (media checksums)
  ├─ rclone pull from R2 → exiftool strip EXIF
  ├─ compress.js: sharp (images) / ffmpeg (videos + music)
  ├─ tests: worker-smoke.mjs
  ├─ generate.js (Markdown → JSON → EJS HTML + RSS/Sitemap)
  ├─ upload.js: rclone push processed → rclone push originals (EXIF-free)
  ├─ strip dist media
  └─ wrangler pages deploy
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
- **music**: Audio files in `music/` directory (transcoded to MP3 128k/320k)

## Configuration

See `mosaic.config.json` for all settings. Key v0.8 additions:
- `plugins` — Feature toggles (compress-images/videos, generate-feed/sitemap)
- `imageQuality` / `videoQuality` — Compression quality settings
- `components` — Frontend component toggles (gallery/video/music/comments/search/likes/stats)
- `theme` — Active theme name
- `mediaSource` — R2 bucket configuration
