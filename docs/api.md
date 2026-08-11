# Mosaic API 参考

Base URL：`https://mosaic-api.xsanye.cn`（前台与后台经 Pages Functions 同源代理到 `/api/*`，无需跨域）。

## 认证

### 登录

`POST /api/auth/login`

```json
{ "password": "..." }
```

返回：`{ "token": "<jwt>", "expires": 86400 }`。后续请求在 `Authorization: Bearer <token>` 头携带。

安全默认：
- `JWT_SECRET` 未配置且已设 `ADMIN_PASSWORD` → 503 fail-closed（不签发、不校验）
- `ADMIN_PASSWORD` 未配置 → 仅当 `DEV_MODE=true` 才允许无鉴权
- 登录失败限流：5 次失败 / 5 分钟 / IP（IP 经 Pages 代理的 `X-Real-IP` + `PROXY_SECRET` 签名识别）

### 刷新

`POST /api/auth/refresh` —— 携带有效 JWT 调用即成功（用于前端启动时校验）。

## 公开端点（无需认证）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/health/github` | GitHub 真实探测（rate_limit，返回 latency/httpStatus） |
| GET | `/api/health/r2` | R2 真实探测（head 探测，返回 latency） |
| POST | `/api/track/view/:slug` | 浏览计数 +1（IP 去重 10 分钟） |
| POST | `/api/track/like/:slug` | 点赞/取消点赞，body `{"action":"like"\|"unlike"}` |
| POST | `/api/track/dwell/:slug` | 停留时长上报，body `{"seconds":N}`（上限 7200） |

> 公开 track 端点有每 IP 每分钟 60 次的频率限制（超出返回 429 `TRACK_RATE_LIMITED`），
> 防止刷量攻击；正常访客流量远低于该阈值。
| GET | `/api/stats/traffic` | 30 天流量聚合（byDay/byCategory/byTag/top5） |
| GET | `/api/stats/:slug` | 单篇实时统计 `{views, likes, dwell_time}` |
| GET | `/api/media/file/:slug/:filename` | 文件服务（向后兼容，搜索 processed + originals） |

## 需认证端点

### 文章

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/posts?limit=&cursor=` | 文章列表（分页；不带参数返回全部） |
| GET | `/api/posts/:slug` | 单篇详情（frontmatter + body） |
| POST | `/api/posts` | 新建/更新，body `{slug, frontMatter, body, message?}` |
| POST | `/api/posts/:slug/duplicate` | 复制文章，body `{newSlug?}` |
| DELETE | `/api/posts/:slug` | 删除文章（含 R2 originals + processed） |

### 配置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 读取 `mosaic.config.json` |
| PUT | `/api/config` | 更新（**深合并**，不会丢嵌套字段） |

### 构建

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/build` | 触发构建（workflow_dispatch，回退 push-trigger）；进行中返回 409 |
| GET | `/api/build/status` | 最近一次运行状态（含步骤明细） |
| GET | `/api/build/history` | 最近 10 次运行 |
| GET | `/api/build/progress` | 管线实时进度（R2 `site-data/build-progress.json`） |

### 媒体

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/media/:slug/list` | 媒体列表（按扩展名分 photos/videos/music） |
| DELETE | `/api/media/:slug/:file` | 删除单个媒体（originals + processed，分页遍历） |
| POST | `/api/upload/presign` | 生成直传 URL，body `{slug, filename, contentType?}` → `{url, key, folder, expires}` |
| POST | `/api/upload/complete/:slug/:filename` | 确认直传落地并标脏；对象不存在返回 404 |
| POST | `/api/upload/direct/:slug/:filename` | Worker 直传兜底（≤100MB），body 为文件本体 |

### 分类标签

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/taxonomy` | 分类/标签统计 |
| PUT | `/api/taxonomy/category` | 重命名分类，body `{oldName, newName}` |
| PUT | `/api/taxonomy/tag` | 重命名标签 |
| DELETE | `/api/taxonomy/category` | 从所有文章移除分类，body `{name}` |
| DELETE | `/api/taxonomy/tag` | 从所有文章移除标签 |

### 统计与运维

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/stats` | 站点统计（文章/分类/标签数量） |
| GET | `/api/stats/posts` | 批量文章实时统计（60s 缓存） |
| GET | `/api/disk` | R2 用量与费用估算（60s 缓存，并行遍历） |
| GET | `/api/cleanup` | 扫描孤儿文件 |
| DELETE | `/api/cleanup` | 删除孤儿文件 |
| DELETE | `/api/processed-cache` | 清空 processed/ 缓存 |
| GET | `/api/dirty` | 未构建变更计数 |
| GET | `/api/trash` | 回收站（stub，返回空数组） |

## 错误格式

```json
{ "error": "Human readable message", "code": "MACHINE_CODE" }
```

常见错误码：`AUTH_REQUIRED` / `AUTH_EXPIRED` / `AUTH_RATE_LIMITED` / `CONFIG_ERROR` / `NOT_FOUND` / `INVALID_PARAMS` / `PAYLOAD_TOO_LARGE` / `GITHUB_ERROR` / `R2_ERROR` / `BUILD_RUNNING` / `SLUG_CONFLICT`。

## 预签名上传示例

```bash
# 1. 登录拿 token
TOKEN=$(curl -s -X POST https://mosaic-api.xsanye.cn/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"..."}' | jq -r .token)

# 2. 获取直传 URL
URL=$(curl -s -X POST https://mosaic-api.xsanye.cn/api/upload/presign \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"my-post","filename":"clip.mp4"}' | jq -r .url)

# 3. 直连 R2 上传（不经 Worker 中转）
curl -X PUT "$URL" --data-binary @clip.mp4

# 4. 确认并标脏
curl -s -X POST https://mosaic-api.xsanye.cn/api/upload/complete/my-post/clip.mp4 \
  -H "Authorization: Bearer $TOKEN"
```

## 脏标记（X-Dirty）

所有 `/api/*` 响应带 `X-Dirty: <count>|<lastISO>` 头（存在未构建变更时）。写操作（文章/配置/上传）自动标脏，构建触发后清除。Admin 前端据此显示黄色横幅。
