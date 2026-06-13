# Mosaic Media Guide

## Overview

Mosaic v0.8 separates media storage from content. Media files (images, videos, audio) are stored in Cloudflare R2 and referenced from your Markdown posts.

## Directory Structure

```
content/posts/{slug}/
├── index.md          # Required: Markdown content with YAML frontmatter
├── cover.jpg         # Optional: Cover image (or cover.png, cover.webp)
├── photos/           # Optional: Gallery images
│   ├── img-001.jpg
│   └── img-002.webp
├── videos/           # Optional: Video files
│   └── video-001.mp4
└── music/            # Optional: Audio files
    └── track-01.flac
```

## Images

### Supported Formats
- JPEG (.jpg, .jpeg)
- PNG (.png)
- WebP (.webp)
- TIFF (.tiff)

### Processing
Images are automatically compressed to WebP at three resolutions:
- **480p** (854px wide) — Small screens and thumbnails
- **720p** (1280px wide) — Medium screens
- **1080p** (1920px wide) — Large screens and fullscreen viewer

The `srcset` attribute is used for responsive loading.

### Gallery Modes
- **Grid mode** (default): CSS masonry grid, 2-4 columns depending on viewport
- **Single mode**: Large stacked images when ≤ N photos (configurable via `gallerySingleThreshold`)

### Fullscreen Viewer
Click any gallery image to enter fullscreen:
- Left/Right arrows or keyboard ← → to navigate
- Bottom filmstrip for quick navigation
- Quality selector (low/high/original)
- Pinch-to-zoom and double-tap zoom
- Scroll to zoom

## Videos

### Supported Formats
- MP4 (.mp4) — Recommended
- MOV (.mov)
- AVI (.avi)
- MKV (.mkv)
- WebM (.webm)

### Processing
Videos are transcoded by FFmpeg:
- Multi-resolution MP4 (480p, 720p, 1080p, 4K if source allows)
- HLS streaming segments (.m3u8 + .ts)
- Poster frame extracted at 1 second

### Video Player
Custom controls include:
- Play/pause
- Progress bar with seek preview
- Volume control
- Playback speed (0.5x - 2x)
- Quality switching
- Picture-in-Picture
- Fullscreen
- Keyboard shortcuts: Space, ← → (seek), ↑ ↓ (volume), F (fullscreen), M (mute)

### Playlist Mode
Set `video_mode: playlist` in frontmatter to show a playlist bar below the video. Click to switch between videos.

## Cover Images

### Auto-Detection
1. Explicit cover: `cover: cover.jpg` or `cover: video:0` or `cover: photo:0`
2. Auto-detect: Video poster frame → First photo → None

### Aspect Ratio
Covers respect the original image aspect ratio (with configurable min/max via `coverAspectMin` and `coverAspectMax`).

## Best Practices

- Use `.jpg` for photos (smaller file size)
- Use `.mp4` for videos (best browser support)
- Use `.flac` for music (best quality — auto-converted to MP3)
- Keep photos under 4000px wide for faster processing
- Keep videos under 4K / 30fps for reasonable transcode times
- Name files without spaces (use hyphens or underscores)
