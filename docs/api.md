# Worker API

前台和后台均可使用 Pages `/api/*` 代理。受保护接口用 `Authorization: Bearer <JWT>`；登录为 `POST /api/auth/login`，body 为 `{password}`。内部流水线使用独立签名，管理员 JWT 不被接受为发布凭据。

## 内容与原有接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health`、`/api/health/github`、`/api/health/r2` | 健康探针 |
| GET | `/api/posts?limit=&cursor=` | 精简文章列表；无正文和波形 |
| GET | `/api/posts/:slug` | 编辑所需 Markdown/frontMatter/SHA |
| POST | `/api/posts` | 创建或保存 `{slug,frontMatter,body,message}` |
| DELETE | `/api/posts/:slug` | 删除、撤销处理任务；保护部署引用 |
| POST | `/api/posts/:slug/duplicate` | 复制文本内容 |
| GET / PUT | `/api/config` | 共享默认值与校验，处理参数变化自动协调任务 |
| GET / PUT / DELETE | `/api/taxonomy` 及 category/tag 子路径 | 分类标签管理 |
| GET | `/api/dirty` | DO 持久化变更状态 |
| GET | `/api/stats`、`/api/stats/posts`、`/api/stats/traffic` | 后台统计 |
| GET | `/api/stats/:slug` | 公开单篇统计 |
| POST | `/api/track/view/:slug`、`/api/track/like/:slug`、`/api/track/dwell/:slug` | 统计写入，保留 DO 与限流 |
| GET / DELETE | `/api/cleanup` | 孤儿清理，排除被部署引用的对象 |
| DELETE | `/api/processed-cache` | 有 JOBS 时重新排队，返回 queued/retained；不会清空在线产物 |

## 上传

| 方法 | 路径 | 输入 / 响应 |
| --- | --- | --- |
| POST | `/api/upload/direct/:slug/:filename` | 原始二进制 body；平台大小限制仍适用 |
| POST | `/api/upload/presign` | `{slug,filename,contentType}` → 签名 PUT URL |
| POST | `/api/upload/complete/:slug/:filename` | HEAD 验证上传，再登记任务 |
| POST | `/api/upload/multipart/start` | `{slug,filename,size,contentType,uploadId?}` → 分片 URL，可恢复 |
| POST | `/api/upload/multipart/parts` | `{slug,filename,uploadId}` → 已上传分片 |
| POST | `/api/upload/multipart/complete` | 同上；服务端核验并组装分片，再登记任务 |
| POST | `/api/upload/multipart/abort` | 同上，取消尚未完成的上传 |
| GET / DELETE | `/api/media/:slug/list`、`/api/media/:slug/:file` | 后台媒体列表与删除 |

三种上传完成响应兼容原字段并增加 `taskId`、`status`。重复确认同一源 ETag 和配置指纹返回同一 taskId 与 `duplicate:true`。分片任务保存 uploadId 作为完成收据，重复 complete 不会再次组装或登记。未完成上传不会发布清单引用。

## 媒体任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/media-jobs` | 精简任务列表，无配置、租约、断点波形 |
| GET | `/api/media-jobs/:id` | 详情、源身份、重试次数、已发布断点 |
| POST | `/api/media-jobs/:id/retry` | 重置重试预算并重新排队 |
| POST | `/api/media-jobs/:id/cancel` | 撤销单任务租约，不取消同批其它文件 |
| POST | `/api/media-jobs/reconcile` | 按当前配置核验源版本，增量排队 |

旧任务被替换或删除后重试/回调返回 409，不会恢复被删除媒体。

## 站点部署

保留 `/api/build` 与 `/api/build/{status,history,run/:id,progress,cancel,done}`。`POST /api/build` 只调度站点工作流。`POST /api/build/done` 仅返回兼容确认 `acknowledged:false`，不会清空脏标记。进度绑定 runId，部署记录含 gitSha/mediaRevision。

## 内部流水线契约

`POST /api/internal/media/{claim,heartbeat,publish,complete,failed,import,state}`；`POST /api/internal/site/{begin,progress,done}`。

签名头：`X-Mosaic-Time` 为毫秒时间戳，`X-Mosaic-Signature` 为 `HMAC-SHA256(PIPELINE_SECRET, timestamp + '.' + 原始 JSON body)` 的小写十六进制。时间窗为 5 分钟。

媒体 claim 返回带 token、runId、generation、source、配置和 checkpoint 的任务；后续回调都带 `{id,token,runId}`。publish 先验证对象 HEAD，再更新 `published`。complete 的 `complete:false` 表示仍有高档待续跑；failed 消耗有限重试预算。site begin 返回固定清单和构建 token，后续 done 成功只确认已覆盖的变更。

旧部署、旧租约、旧源版本和错误签名不能覆盖新状态。内部接口禁止使用后台登录 token 代替流水线签名。

## 编辑器媒体列表

`GET /api/media/:slug/list` 返回 `photos/videos/music/covers`。条目兼容 `name/url/size` 并增加 `id/order/status/taskId/published/previewUrl`。`url` 使用实际源对象键，源文件不可用时回退已发布预览；`previewUrl` 取清单中的图片小档、视频海报或音频封面。孤立旧封面保留在 `covers`，不占用 `photo:N`；各列表与构建复用排序约定，不包含波形或任务租约。客户端上传 PUT 成功后若完成确认失败，应重试完成接口，避免重传文件。
