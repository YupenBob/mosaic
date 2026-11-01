# 媒体域安全与边缘隔离

媒体桶通过公网域名（默认 `mosaic-media.xsanye.cn`）提供 R2 对象。公开桶无法按对象鉴权，因此边缘隔离由 **Zone WAF custom rule** 完成：只放行站点真正需要的路径前缀，其余前缀一律 block。

规则由 `scripts/ops/secure-media-domain.mjs` 下发，`infrastructure.yml` 在 Worker/后台部署之后执行。

## 白名单规则

```
(http.host eq "<MEDIA_ORIGIN>" and not (
  starts_with(http.request.uri.path, "/processed/") or
  starts_with(http.request.uri.path, "/originals/") or
  starts_with(http.request.uri.path, "/site-data/favicon.")
))
=> action: block
```

| 前缀 | 用途 | 可见性 |
| --- | --- | --- |
| `/processed/` | 压缩后的图片、HLS/MP4、音频、poster | 公开（站点播放必需） |
| `/originals/` | 原图/原视频（重新转码、补帧的数据源） | **公开但不应被嵌入页面**，见残余风险 |
| `/site-data/favicon.*` | 后台设置的站点头像 / favicon | 公开（浏览器直接加载） |
| 其他 `site-data/*` | manifest、posts-index、迁移标记、usage 快照 | block |
| `previews/*` | 私密预览（由 Worker 签名 token 代理） | block |
| `drafts/*` | 云草稿 | block |

脚本特性：

- **幂等**：规则按 `description` 识别（`Mosaic: media domain exposure allowlist`），已一致时 no-op。
- **合并不覆盖**：读取 zone `http_request_firewall_custom` entrypoint，保留其他规则的顺序与内容，只替换本项目的规则。
- **`--dry-run` 先行**：无凭据时也会打印目标表达式与规则数，不发起写请求。

```bash
# 计划（无需凭据）
node scripts/ops/secure-media-domain.mjs --dry-run

# 执行（需要 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID，account id 由 workflow 注入）
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ZONE_ID=... node scripts/ops/secure-media-domain.mjs --apply
```

首次启用 WAF 后，边缘可能仍缓存着旧的 `site-data/*` 响应：

```bash
node scripts/ops/purge-site-data.mjs            # 打印 URL
node scripts/ops/purge-site-data.mjs --apply    # 清缓存（按 URL，每批 ≤30）
```

## 验证（每次部署后 / 每 3 小时）

`probe.yml` 每 3 小时运行 `scripts/ops/probe.mjs`（零依赖、不执行 `npm ci`、<1min），其中私有前缀断言有两种模式：

- **默认 warn-only（首轮上线）**：私有路径返回 200 只记 `WARN`，探针整体不失败。用于 WAF 规则刚下发、边缘缓存尚未清理的观察期。
- **严格模式**：`PROBE_STRICT_PRIVATE=1` 时，私有路径返回 200 视为失败，退出码 1 并自动开/更新 `ops-alert` issue。
- 切换位置：`.github/workflows/probe.yml` 中 `PROBE_STRICT_PRIVATE` 的**注释行**。确认连续一轮全绿（私有前缀 403/404、CORS/206/越权检查全 PASS）后取消注释即可。
- 本地运行默认也是 warn-only，避免在未配置 WAF 的开发环境误报。

无论哪种模式，私有路径返回 5xx、受保护路由返回 200、图片缺 CORS 或 HLS 非 206 一律失败。

同时检查：`/api/health/*`、真实 `processed` 媒体 200+CORS、HLS 分片 Range 206、Worker 受保护路由不带凭据不得返回 200、后台首页可加载、`build-snapshot.json` 新鲜度。

浏览器级回归仍在 `health-check.yml`（每日一次，Playwright 缓存 + 真实请求断言图片 200 与 CORS），与零依赖 probe 分工明确，互不重复触发。

## 上线检查清单

1. **凭据就绪**（本地一次性核对，只读、不打印 token）：

   ```bash
   node scripts/ops/preflight.mjs          # 人读输出
   node scripts/ops/preflight.mjs --json   # 机器可读
   ```

   `preflight.mjs` 从仓库根 `.secrets/` 读取（该目录已被 `.gitignore` 忽略）：
   `github_token`、`cloudflare_token`、`cloudflare_account_id`、`cloudflare_zone_id`。
   断言：

   - GitHub `GET /user` 200，且 `GET /repos/<repo>` 的 `permissions.push === true`；
   - Cloudflare `GET /user/tokens/verify` success；
   - `GET /zones/{zone}` success；
   - `GET /zones/{zone}/rulesets/phases/http_request_firewall_custom/entrypoint`：记录是否存在；403 表示 token 缺 WAF 权限，仅警告，不影响其他检查；
   - R2 `HeadObject('site-data/media-manifest.json')`：需要导出 `R2_ACCESS_KEY`、`R2_SECRET_KEY`、`R2_ENDPOINT`（或 `CF_ACCOUNT_ID`），未导出时跳过并提示；桶名取自 `mosaic.config.json`。

   退出码：0 通过（警告不影响），1 必需检查失败，2 `.secrets/` 或凭据缺失。

2. GitHub 仓库 Variables：`CLOUDFLARE_ZONE_ID`、`MEDIA_ORIGIN`（可选，默认取 `mediaBase` 主机名）、`R2_BUCKET`、`API_TARGET`、`SITE_BRANCH`。
3. Secrets：`CLOUDFLARE_API_TOKEN`（含 Zone WAF 编辑 + Pages 部署 + R2 管理）、`CLOUDFLARE_ACCOUNT_ID`、`R2_ACCESS_KEY`、`R2_SECRET_KEY`、`R2_ENDPOINT`、`PIPELINE_SECRET`。
4. 先部署 Worker（`infrastructure.yml`），`Secure media domain (WAF allowlist)` 步骤随后下发规则；首次执行后运行 `purge-site-data.mjs --apply`。
5. `probe.yml` 手动跑一次：先用默认 warn-only 模式确认私有前缀是 403/404、其余检查全绿，再取消 `.github/workflows/probe.yml` 里 `PROBE_STRICT_PRIVATE` 的注释，进入严格模式。
6. 记录当前 Pages deployment id（`.mosaic/deploy.json` 或 `Actions → Mosaic Site` 摘要），必要时用 `rollback.yml` 回退。

## 运维与清理

`maintenance.yml`（每周一 03:00 UTC + 手动，手动默认 dry-run）按顺序执行：

| 脚本 | 作用 | 安全边界 |
| --- | --- | --- |
| `scripts/ops/r2-lifecycle.mjs` | `previews/` 14 天过期；未完成分片上传 2 天中止 | 合并已有 lifecycle 规则，只替换本项目的规则 id |
| `scripts/ops/gc-manifests.mjs` | 删除 `site-data/media-manifests/*` 快照 | 仅删除 **未被部署/构建引用** 且 >180 天的快照；无法读取 Worker 状态时拒绝删除 |
| `scripts/ops/prune-previews.mjs` | 清理过期预览 | 以 `previews/<id>/meta.json` 的 `expiresAt` 为准，`queued/building` 状态跳过 |
| `scripts/ops/prune-drafts.mjs` | 清理 30 天未更新的云草稿 | 默认 dry-run，`--apply` 才删除 |

全部脚本默认 dry-run（`--apply` 或 `MOSAIC_APPLY=true` 才写），且先列清单再删除。

## 渐进上线（降级模式）

首次发布时仓库可能还没有 `CLOUDFLARE_ZONE_ID` 变量，或 `CLOUDFLARE_API_TOKEN` 不含
Zone WAF Edit 权限。`secure-media-domain.mjs --apply` 在这种情况下的行为是**可选的降级**：

- 默认（非 strict）：打印 `DEGRADED: ...` 并以 0 退出，release 不会被 Cloudflare 侧前置条件卡住；
  `drafts/`、`previews/`、`site-data/` 在此阶段仍然可被直连读取（代码侧已关闭 Worker 读取面）。
- 传 `--strict` 或 `WAF_STRICT=1`：缺 zone/权限或下发失败直接以 1 退出，用于 WAF 落地后防回归。

建议节奏：① 先按降级模式完成首次发布；② 在仓库 Variables 增加 `CLOUDFLARE_ZONE_ID`
（必要时补 `MEDIA_ORIGIN`）；③ 手动 dispatch `infrastructure.yml` 一次并确认日志显示规则写入；
④ 用 `node scripts/ops/probe.mjs`（先 `PROBE_STRICT_PRIVATE` 注释状态）确认私有前缀 403/404；
⑤ 打开 probe 的严格开关，并把 `infrastructure.yml` 的 WAF step 改为 `--strict`。

## 回滚

- **站点**：`rollback.yml` → `scripts/ops/rollback.mjs`，默认打印当前/目标 Pages deployment，`--apply`（workflow 里 `confirm=rollback`）才调用
  `POST /accounts/{account}/pages/projects/{project}/deployments/{deploymentId}/rollback`。
- **媒体域规则**：把 `secure-media-domain.mjs` 的表达式改回旧版本重跑，或直接在 Cloudflare Dashboard 调整本规则；脚本合并语义保证不会误删其他 WAF 规则。
- **媒体对象**：迁移不删除旧 key（`originals/<slug>/...`、`processed/<slug>/...` 保留），可按 manifest 回滚引用。

## 残余风险

1. **`originals/` 仍公开**：白名单保留 `/originals/`，因为重新转码、补帧与旧前端仍可能直接引用原文件。修复方向是改为 Worker 签名代理（或把 originals 移入不公开的 bucket），在完成前不要把含 EXIF/位置信息的原图当作私密内容。
2. **EXIF 待回填**：新上传由处理管线剥离 EXIF（`processed/`），但历史 `originals/` 中已有文件未统一回填剥离；在 originals 私有化之前，内部敏感照片不要上传。
3. **WAF 是兜底，不是对象级鉴权**：任何新前缀写入 R2 都不会自动公开，但新增白名单必须走代码评审（本文件的表格与 `secure-media-domain.mjs` 一起改）。
4. **probe 依赖公共网络**：prod 探测在 Actions 中运行；本地无网络时 `--dry-run` 仍可用（只打印计划）。
5. **`site-data/favicon.` 前缀**只应包含后台 favicon 对象；不要在该前缀下放其他内容。

## 相关文件

- `scripts/ops/secure-media-domain.mjs`
- `scripts/ops/purge-site-data.mjs`
- `scripts/ops/probe.mjs` / `.github/workflows/probe.yml`
- `scripts/ops/preflight.mjs`
- `scripts/ops/r2-lifecycle.mjs`、`gc-manifests.mjs`、`prune-previews.mjs`、`prune-drafts.mjs` / `.github/workflows/maintenance.yml`
- `scripts/ops/rollback.mjs` / `.github/workflows/rollback.yml`
- `.github/workflows/health-check.yml`、`tests/check-site.mjs`
