# 媒体指南

通过云后台上传图片、视频、音频。文本保存到 Git，原文件保存到 R2；上传完成即自动登记媒体任务，无需点击站点构建来启动处理。生产媒体处理和上传处理产物只在 GitHub Actions 执行。

## 发布行为

首次上传产生处理中占位。同名重传创建新源版本，但前台继续使用旧产物；新对象全部上传验证后才切换。删除撤销旧任务，已经部署的对象保留到不再被引用。后台构建中心分别显示媒体任务与站点部署。

视频默认从 240p 向高档处理，不放大低分辨率源；每完成一个档位先验证分片、播放列表、MP4、海报，再生成新 master 并上线。剩余档位自动续跑。图片使用配置的 WebP 质量，自动旋转、移除 EXIF/GPS、生成占位图与清洁原图。音频使用独立处理器输出 MP3、400 桶波形、元数据和专辑封面。

## 几 KB 预览图（LQIP）

列表卡片不会一上来就下载高清图：

- 图片：使用处理时已生成的 `placeholder.webp`（`media.image.placeholderWidth=150` /
  `placeholderQuality=30`，通常 1–6KB），不新增处理参数，因此**处理指纹不变、不触发重转码**。
- 视频：生成海报时额外输出 `poster-preview.webp`，写入清单 `published.posterPreview`。
- 音乐：提取封面时额外输出 `cover-preview.webp`，写入 `published.coverPreview`。

构建把预览地址写入 `posts-index.json` / `posts.json` 的 `coverLqip`（以及 `feed.json` /
`notes/{slug}.json`）。前台先渲染预览（模糊占位），`cards/media.js` 在图片接近视口或首屏优先时
解码高清图并原位替换；极端/旧媒体没有预览时直接加载原图，不阻塞页面。删除/重建媒体后新产物
自动带上预览，无需人工干预。

## 对象与身份

原文件为 `originals/{slug}/{photos|videos|music}/{filename}`，旧根目录 cover 由迁移适配。新产物为 `processed/{slug}/{folder}/{generation}/...`。文件名可含中文与空格，清单保存原文件名和实际对象键，生成地址统一 URL 编码。源 ETag、版本与处理配置指纹共同决定幂等性；原文件哈希流式计算。

## 内容编排

地址保持 `/posts/{slug}/`。默认顺序为正文、画廊、视频、音乐；占位符单独成行并前后留空行：

```markdown
开头文字。

{{photo:0}}

{{video:0}}

{{gallery}}

{{videos}}

{{music}}
```

`photo:N`、`video:N` 从 0 开始，首次处理中的文件也占据自己的位置，避免同一编号指向后面的媒体。越界或代码块中的占位符保留原文。未引用的媒体类型追加一次。无占位符时可使用 `blocks: [music, text, gallery, videos]`。

视频模式仍使用 `video_mode: stacked` 或 `playlist`。封面支持 `cover: video:0`、`photo:0`、文件名与绝对 URL；默认视频海报优先，其次首张图片。画廊保留缩放、胶片导航和清晰度，视频保留 HLS/MP4、倍速、PiP、全屏、恢复与播放列表。音乐见 [音乐指南](music-guide.md)。

## 补帧与源文件保留

**转码补帧（光流）**：在站点设置或 `videoQuality.interpolation` 开启后，视频档位转码会追加
ffmpeg `minterpolate` 光流插帧（默认 60fps、`mi_mode=mci`、`mc_mode=aobmc`、
`me_mode=bidir`、`vsbmc=1`）。补帧与缩放在同一次编码中完成，输出 yuv420p、偶数宽高；发布
契约（全部 MP4/HLS 分片/播放列表/海报 HEAD 验证通过后才切换）与低档优先策略不变。参数建议：
源 24/30fps → 目标 48/60fps；目标帧率不是源帧率的整数倍时画面节奏可能不匀。补帧显著增加编码
时间，请评估 Actions 预算。

**后补帧（已完成解码的视频）**：后台媒体任务/文章编辑器提供“后补帧”操作（单条、整篇、全部）。
`POST /api/media/interpolate` 会登记 `sourceMode=processed` 的任务：直接读取**已发布**的档位 MP4
做补帧重编码并重新分片，不下载原始源文件；即使 `originals/` 已删除仍可用。新产物写入新
generation，全部验证后切换，旧部署继续可用。

**保留源文件**：`media.keepSourceFiles` 为全局默认，上传视频时可逐次覆盖。关闭后，任务全部
档位发布成功后协调器会删除 `originals/...` 并标记 `source.available=false`。删除是不可逆的：
之后只能基于已发布产物后补帧，无法从源重新转码（例如更换编码参数/分辨率）；需要重转码请保留
源文件。

## 调整与恢复

配置见 [configuration.md](configuration.md)。处理参数变化会自动对对应类型排队，域名或标题变化不触发重转码。任务默认首次失败后最多重试三次；耗尽后后台显示错误并可重试。预算用尽时保留已发布档位并自动续跑，上传失败的对象不会进入公开清单。

`npm run build` 只生成站点；`npm run media:process` 要求 Actions 运行 ID、R2 凭据与流水线签名。已有产物迁移只核验 R2 对象，不在站点构建中下载原文件。详见 [迁移](migration.md)。
