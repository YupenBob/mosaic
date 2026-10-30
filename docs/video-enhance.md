# 视频增强

视频增强是独立页面（`#enhance`），不混在素材上传里。每次增强都会生成新的一代产物，旧产物保留；原素材是否保留由任务选项决定。

## 三种操作

| operation | 行为 |
| --- | --- |
| `interpolate` | 只做 AI 补帧（ffmpeg `minterpolate`） |
| `reencode` | 不补帧，只按新的 CRF/preset/音频码率重新编码 |
| `both` | 先补帧，再按新的编码参数输出 |

## 输入来源

- `processed`：从已发布的分层 MP4 重新编码；原文件删除后仍可用。默认。
- `original`：从 R2 `originals/` 重新编码；原文件已删除时任务跳过，提示 `source-missing`。

## API

`POST /api/media/interpolate`

```json
{
  "assetIds": ["ast_..."],
  "operation": "both",
  "sourceMode": "original",
  "fps": 60,
  "reencode": { "crf": 23, "preset": "fast", "audioBitrate": "128k" }
}
```

也兼容旧的 `slug` / `filename` / `all: true` 范围。返回 `enqueued/tasks/skipped`。

## 任务

- 任务带 `options.operation`、`options.sourceMode`、`options.reencode`。
- `interpolate`/`both` 写 `options.interpolation`；`reencode` 写 `enabled:false` 的插值选项，runner 不会执行补帧。
- 新任务使用新的 `generation`，R2 前缀 `processed/assets/<id>/<generation>/`。
- 生命周期：任务进行中 `processing`；成功后 `ready`；失败但有旧产物 `degraded`。

## 页面

- 选择视频、操作、输入来源、帧率；`reencode`/`both` 显示 CRF/preset/音频码率。
- 提交后跳到任务中心查看进度。
- 原文件已删除的视频在列表中标记，只能选 `processed`。
