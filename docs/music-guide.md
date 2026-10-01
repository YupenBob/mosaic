# 音乐指南

在云后台编辑器上传 MP3、FLAC、WAV、OGG、M4A 或 AAC。上传完成自动创建独立音频任务，处理完成后自动更新站点。音频顺序沿用文件名排序，正文可用 `{{music}}` 指定位置。

## 处理与清单

默认转码为 128k 和 320k MP3，读取标题、歌手、专辑、时长及内嵌封面。FFmpeg 输出单声道 PCM 到媒体临时目录，波形按文件流计算，避免长音频整段驻留内存。清单保存已验证 MP3 对象键、元数据、封面与波形；文章列表与搜索索引不包含波形。

新输出路径为 `processed/{slug}/music/{generation}/...`，旧 `{base}-128k.mp3`、`{base}-meta.json` 和 `{base}-waveform.json` 由迁移适配核验并导入。首次上传显示占位；重传继续播放旧版本直到新任务验证完成。

## 播放器

保留曲目列表、全局 mini 播放器、前后切换、循环模式、波形与点击定位、播放状态恢复。模板注入的 `window.__MUSIC_TRACKS` 不会再被模块初始化清空。图标按钮提供可访问名称。

## 配置

在 `mosaic.config.json` 中设置 `media.audio.bitrates`、`waveformBuckets`、`sampleRate`。默认分别为 `["128k","320k"]`、400、8000。改变音频处理参数自动登记新任务；关闭图片或视频压缩不会影响音频。通用超时、重试和保留策略见 [配置指南](configuration.md)。
