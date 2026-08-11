# Mosaic 音乐指南

## 概览

Mosaic 提供一等公民的音乐支持：把音频放进文章的 `music/` 目录，管线自动转码，前台渲染曲目列表与全局 mini 播放器。

## 快速开始

```
content/posts/my-mix/
├── index.md
├── cover.jpg              # 可选：作为曲目封面
└── music/
    ├── track-01.flac
    ├── track-02.wav
    └── track-03.mp3
```

文章 frontmatter 无需额外配置，音频自动出现在正文后的"音乐"区块。

## 支持格式

| 格式 | 扩展名 | 说明 |
| --- | --- | --- |
| FLAC / WAV | `.flac` / `.wav` | 无损，转码为 MP3 |
| MP3 | `.mp3` | 直接使用 |
| M4A / AAC | `.m4a` / `.aac` | 转码为 MP3 |
| OGG | `.ogg` | 转码为 MP3 |

## 音频处理

管线对每个音频文件转码两个码率：

- **320kbps** — 高音质
- **128kbps** — 省流量

同时用 ffmpeg 解码生成 **400 个归一化波形峰值**（存于 `processed/{slug}/music/{base}-waveform.json`，
并随媒体 checksums 清单缓存，缓存命中的构建也能直接使用）。产物存于 `processed/{slug}/music/`，
页面引用压缩版、缺失时回退原始文件。

**元数据与封面**：管线用 ffprobe 读取每首曲目的时长与 `title` / `artist` / `album` 标签
（存于 `{base}-meta.json` 并写入媒体 checksums 清单）；内嵌专辑图自动导出为
`{base}-cover.jpg`。前台曲目列表据此显示封面缩略图与时长，mini 播放器与 Media Session
同步使用封面与时长；没有标签或封面的文件自动回退为文件名 / 站点作者 / 占位图标。

## 播放器功能

- 播放/暂停、上一首/下一首
- 三种循环模式：列表循环 / 单曲循环 / 随机
- 音量记忆、播放进度记忆（刷新后恢复）
- Media Session（锁屏/系统媒体控制）
- 底部 mini 播放器，跨页面保持播放状态
- **波形可视化**：文章音乐区块顶部显示当前曲目的 400 点波形，随播放进度着色，点击波形可跳转播放位置

## 嵌入文章

曲目以列表形式渲染在文章"音乐"区块，每项显示封面缩略图、标题、作者与时长
（标题/作者优先取音频内嵌标签，缺失时回退文件名与站点 `author.name`）。点击即播放。

## 配置

音乐默认启用，无需额外配置。波形峰值的桶数（默认 400）、转码档位与元数据/封面提取
在管线 `compress.js` / `music-meta.mjs` / `media-utils.mjs` 内调整。
