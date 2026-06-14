# Mosaic Configuration Reference

## mosaic.config.json

All configuration is in `mosaic.config.json` at the project root.

### Site

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `title` | string | `"Mosaic"` | Site name shown in header and `<title>` |
| `subtitle` | string | `""` | Tagline |
| `description` | string | `""` | Meta description for SEO |
| `url` | string | `""` | **Required.** Base URL for RSS, sitemap, OG tags (e.g. `https://example.com`) |
| `language` | string | `"zh-CN"` | UI language (`zh-CN` or `en`) |
| `favicon` | string | `"/assets/logo.svg"` | Path to favicon |
| `author.name` | string | `""` | Author name for RSS |
| `author.email` | string | `""` | Author email for RSS |
| `dateFormat` | string | `"YYYY-MM-DD"` | Date display format |
| `footerText` | string | `""` | Custom footer text |

### Layout

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pageSize` | number | `50` | Posts per page |
| `gallerySingleThreshold` | number | `5` | ≤ N photos → single-column large images |
| `coverAspectMin` | number | `0.5625` | Minimum cover aspect ratio (9:16) |
| `coverAspectMax` | number | `999` | Maximum cover aspect ratio |
| `cardShowTags` | boolean | `true` | Show tags on post cards |
| `cardShowStats` | boolean | `true` | Show view/like stats on cards |
| `searchMinChars` | number | `2` | Minimum characters to trigger search |
| `headerNav` | array | `[]` | Custom navigation links: `[{ "label": "...", "url": "..." }]` |

### Media Processing

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `imageQuality` | object | `{"480p":75,"720p":80,"1080p":85}` | WebP quality per resolution |
| `videoQuality` | object | `{"crf":23,"preset":"fast"}` | FFmpeg encode settings |
| `musicQuality` | object | `{"mp3_320k":{"bitrate":"320k"},"mp3_128k":{"bitrate":"128k"}}` | MP3 encode settings |
| `enableVideoCompression` | boolean | `true` | Enable FFmpeg video transcode |
| `enableMusicProcessing` | boolean | `true` | Enable music metadata extraction |
| `enableBusuanzi` | boolean | `true` | Enable Busuanzi page views |

### Media Source

| Field | Type | Description |
|-------|------|-------------|
| `mediaSource.type` | string | `"r2"` for Cloudflare R2 |
| `mediaSource.bucket` | string | R2 bucket name |
| `mediaSource.endpoint` | string | R2 endpoint URL |
| `mediaSource.publicUrl` | string | Public URL for media access (e.g. `https://media.example.com`) |

### Theme

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `theme` | string | `"default"` | Active theme name (from `themes/` directory) |
| `themeOverrides.colors` | object | `{}` | Override theme colors |
| `themeOverrides.fonts` | object | `{}` | Override theme fonts |
| `themeOverrides.radii` | object | `{}` | Override border radii |
| `themeOverrides.layout` | object | `{}` | Override layout values |

### Plugins

| Plugin | Description |
|--------|-------------|
| `compress-images` | Sharp WebP compression |
| `compress-videos` | FFmpeg video transcoding |
| `extract-music-meta` | Audio metadata extraction |
| `generate-feed` | Atom RSS feed |
| `generate-sitemap` | XML sitemap with SEO |

Set `"enabled": false` to disable any plugin.

### Components

| Component | Description |
|-----------|-------------|
| `gallery` | Photo gallery with fullscreen viewer |
| `video` | Custom video player with HLS |
| `music` | Audio player with mini-player bar |
| `comments` | Giscus comment integration |
| `search` | Client-side full-text search |
| `likes` | LocalStorage-based like button |
| `stats` | Busuanzi views + dwell time |

### Giscus (Comments)

| Field | Description |
|-------|-------------|
| `giscus.repo` | GitHub repository (e.g. `user/repo`) |
| `giscus.repoId` | Repository ID from Giscus |
| `giscus.category` | Discussion category |
| `giscus.categoryId` | Category ID from Giscus |

### Worker

| Field | Description |
|-------|-------------|
| `worker.apiUrl` | Worker API URL (e.g. `https://api.example.com`) |

## Environment Variables

Set these in GitHub Actions Secrets:

| Variable | Required | Description |
|----------|----------|-------------|
| `R2_ACCESS_KEY` | Yes (cloud) | R2 access key ID |
| `R2_SECRET_KEY` | Yes (cloud) | R2 secret access key |
| `R2_ENDPOINT` | Yes (cloud) | R2 S3-compatible endpoint |
| `R2_PUBLIC_URL` | Yes (cloud) | Public base URL for media |
| `CLOUDFLARE_API_TOKEN` | Yes (deploy) | CF API token |
| `CLOUDFLARE_ACCOUNT_ID` | Yes (deploy) | CF account ID |
| `SITE_URL` | No | Override site URL |

## Post Frontmatter

```yaml
---
title: "Post Title"           # Required
date: 2026-06-01              # Required
category: travel              # Default: "uncategorized"
tags: [europe, summer]        # Array of tags
description: "Brief desc"     # Meta description
cover: cover.jpg              # Cover image, or "video:0", "photo:0"
layout: default               # default | video-first | gallery-first | music-first
video_mode: stacked           # stacked | playlist
views: 100                    # Initial view count
likes: 10                     # Initial like count
dwell_time: 300               # Initial dwell time (seconds)
---
```
