# Mosaic Music Guide

## Overview

Mosaic v0.8 adds first-class music support. You can include audio files alongside your photos and videos, with automatic metadata extraction, transcoding, and a built-in web player.

## Quick Start

Create a post with a `music/` directory:

```
content/posts/my-mix/
├── index.md
├── cover.jpg
├── photos/               # optional
├── videos/               # optional
└── music/
    ├── track-01.flac
    ├── track-02.wav
    └── track-03.mp3
```

Set the layout to prioritize music:

```yaml
---
title: "My Mix"
date: 2026-06-01
category: music
tags: [ambient, electronic]
description: "A curated collection"
layout: music-first
---
```

## Supported Formats

| Format | Extension | Lossless | Notes |
|--------|-----------|----------|-------|
| FLAC | `.flac` | Yes | Transcodes to MP3 |
| WAV | `.wav` | Yes | Transcodes to MP3 |
| AIFF | `.aiff` | Yes | Transcodes to MP3 |
| MP3 | `.mp3` | No | 320k copy + 128k version |
| M4A | `.m4a` | No | 320k copy + 128k version |
| OGG | `.ogg` | No | 320k copy + 128k version |

## Audio Processing

The build pipeline automatically:
1. Extracts audio metadata (title, artist, album, genre, cover art) via ffprobe
2. Transcodes lossless files to MP3 at two quality levels:
   - **320kbps** — High quality
   - **128kbps** — Data-saving
3. Extracts embedded album artwork
4. Generates waveform visualization data
5. Outputs `music-meta.json` for the frontend player

## Frontmatter Options

```yaml
layout: music-first    # Shows music player prominently at the top
music_mode: playlist   # 'stacked' (default) or 'playlist' (single player + list)
```

## Music Player Features

The built-in player supports:
- Play/pause, skip, previous track
- Three loop modes: repeat all, repeat one, shuffle
- Waveform visualization with click-to-seek
- Volume control with memory
- Playback position memory (resumes where you left off)
- Media Session API for lock screen controls
- Background playback (persists across page navigation)
- Keyboard shortcuts: Space (play/pause), ← → (seek), ↑ ↓ (volume)

## Embedding in Posts

Music tracks appear as a tracklist section in your post. Each track shows:
- Track number
- Cover art (if available)
- Title and artist
- Duration

Click any track to start playback. The mini-player appears at the bottom of the screen.

## Configuration

In `mosaic.config.json`:

```json
{
  "enableMusicProcessing": true,
  "musicQuality": {
    "mp3_320k": { "bitrate": "320k" },
    "mp3_128k": { "bitrate": "128k" }
  },
  "components": {
    "music": {
      "enabled": true,
      "defaultQuality": "320k"
    }
  }
}
```
