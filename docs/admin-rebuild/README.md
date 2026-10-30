# Mosaic 后台重构执行日志

计划：`Mosaic 后台重构执行计划 v3.1`（Media v2、草稿/预览、主题、视频增强、任务中心、资产生命周期、版本历史、界面重构）。

当前阶段：**P8 收口（进行中）**

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| P0 安全热修 | 完成 | `validSegment`、`jsStr`、`baseSha`、XSS 回归 |
| P1 框架/视觉/动效/预览图 | 进行中 | 壳层、状态胶囊、账户菜单、动效、概览、文章筛选、编辑器两栏、预览图 |
| P2 Media v2 | 进行中 | 资产身份/manifest v2、上传 API、Jobs 双读、v2 构建解析、素材库、生命周期、迁移 CLI、编辑器素材选择器已落地；待真实迁移执行 |
| P3 任务中心/生命周期 | 完成 | 任务中心（素材/媒体、操作、来源）、生命周期、软删除/恢复、到期清理、两代回滚已完成 |
| P4 草稿/预览 | 完成（待真实 Actions 联调） | R2 草稿、草稿模式/发布、草稿列表、私密预览 token/R2/workflow、预览清理已完成 |
| P5 视频增强 | 进行中 | 独立页面、补帧/重编码/两者、processed/original 来源、任务选项与测试已落地；真实 FFmpeg 长任务待联调 |
| P6 主题系统 | 进行中 | 主题包契约、构建时布局/资源解析、default 微调项、starter 示例、后台主题页/API 已落地；主题上传/市场与更多主题待做 |
| P7 版本历史 | 进行中 | Git 提交列表/详情/diff/按文件或整次恢复、后台页面已落地；真实 GitHub 联调待做 |
| P8 收口 | 进行中 | 概览「需要处理」、设置吸顶、上线页收口、13 页 axe、截图回归已落地；真实迁移/预览 Actions 待凭据联调 |

## P0 已落地

- `shared/media-manifest.mjs`：媒体/文章标识拒绝引号、反引号、尖括号、反斜杠、控制字符和 `.`/`..`。
- `cloud-admin/js/escape.js`：新增 `jsStr()`，生成 HTML 属性内安全的 JS 字符串字面量。
- 所有含用户数据的内联处理器（素材名、任务 ID、slug、分类/标签、清理路径、构建 SHA）改用 `jsStr()`；静态处理器保留到 P1 事件委托迁移。
- `worker/src/services/content.js`：`createOrUpdatePost` 支持 `baseSha`；`null` 表示仅创建，缺失/不匹配返回 409。
- `worker/src/routes/posts.js`：GET/POST/DELETE/duplicate 全部校验 slug；错误码透传 `CONFLICT` / `SLUG_CONFLICT` / `INVALID_PARAMS`。
- `cloud-admin/js/editor.js`：记录 `state.editor.baseSha`，保存时携带；409 给出明确提示，不清除未保存状态。
- 新增测试：`tests/security-smoke.mjs`、`tests/post-concurrency.mjs`，接入 `test:security` 与 `test:unit`。

## P0 验证

```bash
node tests/security-smoke.mjs          # passed
node tests/post-concurrency.mjs        # passed
node tests/media-list.mjs              # passed
node tests/admin-local.mjs             # passed (7 pages × 2 themes a11y)
npx eslint <changed files>             # passed
npx prettier --check <changed files>   # passed
```

## 已知边界

- 仍有 65 处静态/无用户数据的内联处理器；P1 统一改为 `data-action` + 事件委托后，才能启用严格 CSP。
- `validSegment` 收紧会影响历史上含引号/尖括号的素材名；当前实例无此数据，迁移前需跑一次扫描。
- 后台草稿仍是 localStorage 版本；R2 草稿与预览在 P4 落地。

## P1 已落地（阶段内）

- 顶栏：全宽 dirty/build banner 改为状态胶囊；新增「+ 写文章」；账户菜单合并主题/语言/访问网站/退出。
- 侧栏：概览、内容、站点、系统分组；「构建与部署」→「上线」，「站点设置」→「设置」，「编辑器」→「写文章」；移除空回收站入口。
- 动效：`js/motion.js` + View Transitions，页面淡出/上移淡入、标题共享过渡；`prefers-reduced-motion` 全关；保留无 VT 回退。
- 概览：4 张 KPI（文章/总浏览/今日/媒体）、今日较昨日、页头动态副标题、区域刷新不整页 reload；移除 6 卡和第二个「概览」小标题。
- 文章：筛选/排序改为数据模型（`js/post-filter.js`），不再只过滤前 100 行 DOM；结果计数不再 `/2`；手机自动卡片、隐藏表格。
- 编辑器：两列布局（正文 + 340px 检查器）；标题/文章链接移到正文顶部；页面标题改为「编辑文章」；保存状态与草稿文案保留。
- 预览图：`/api/posts` 透传构建索引的封面/LQIP/比例/srcset；新增 `/api/media/object` 代理兜底；视频/音频素材格渲染 poster；表格行增加封面缩略图与失败图标。
- 文案：状态胶囊、账户菜单、概览、文章排序/空筛选、编辑器字段等中英同步。
- 测试：`tests/security-smoke.mjs`、`tests/post-concurrency.mjs`、`tests/post-filter.mjs`；admin-local 增加状态胶囊、账户菜单、390px 卡片/无横滚断言。
- 任务中心：新增 `#tasks` 页与 `/api/media-jobs` 过滤/重试/取消/轮询，接入系统分组；上线页暂保留旧的媒体任务面板，待 P3 搬迁。

## P1 待办

- 设置页吸附保存栏、分区分组与高级折叠（P5）。
- 分类/清理/上线页完整视觉重构（P5/P4）。
- 去除剩余静态内联处理器并启用 CSP（P8 前置）。
- 概览「需要处理」「最近上线」卡片、图表条形化（P1 收尾）。

## P2 已落地（底层）

- `shared/media-v2.mjs`：独立 `ast_` 资产 ID、迁移确定性 ID、R2 `originals/assets`/`processed/assets` 路径、v2 manifest 校验、文章 `media` 引用、素材使用索引。
- `tests/media-v2-smoke.mjs`：ID/路径/校验/v1 兼容/引用/使用索引。
- 未切换线上路径；v1 manifest、R2 目录、Jobs DO、构建和后台仍按原逻辑运行。

## P2 第二批（v2 上传链）

- `POST /api/assets` 预签名、`/api/assets/:id/complete`、分片上传/parts/complete/abort；素材 ID 与文章解耦。
- Jobs DO 支持 v2 `enqueue`、`assets-list`、`asset-preview`、`delete-assets`；混合 manifest（v1 slug + v2 `ast_`）通过校验。
- 媒体 runner 支持 `processed/assets/<id>/<generation>`，publish 校验按 v2 前缀。
- 构建 `resolveMedia` 支持 frontmatter `media` 数组，正文继续用 `photo:N` / `video:N`。
- 后台新增 `#library` 素材库初版：列表/筛选/小文件预签名上传/轮询；`/api/assets/:id/preview` 公共缩略图。
- 新增 `tests/media-assets.mjs`、`tests/assets-api.mjs`；`test:unit` 已接入。

## P2 第三批（生命周期与软删除）

- v2 资产增加 `lifecycle`：`processing / ready / degraded / failed / deleting / deleted`，含 `firstPublishedAt/lastPublishedAt/purgeAfter/previousState`。
- 发布完成 → ready；发布中 → processing；任务失败但有旧产物 → degraded；无产物 → failed；源文件删除 → degraded。
- `DELETE /api/assets/:id` 改为软删除（默认 7 天），默认列表隐藏，`POST /api/assets/:id/restore` 可恢复。
- `assets-list` 暴露 `lifecycle`；`asset-preview` 公共缩略图。
- 测试覆盖：v2 发布、失败降级、软删除/恢复、硬删除、重启恢复。

## P2 迁移计划器

- 新增 `scripts/media/plan-v2.mjs`：纯函数，把 v1 资产映射为确定性的 v2 资产 ID、R2 复制对、文章 `media` 引用（含 `photo:N` / `video:N` / 文件名封面）。
- `tests/migrate-v2-plan.mjs`：确定性 ID、复制对、文章引用、已迁移文章跳过。
- 尚未执行实际 R2 复制与文章提交；`migrate-v2.mjs` CLI/apply 是下一轮。

## P2 迁移 CLI（准备执行）

- `scripts/media/migrate-v2.mjs`：默认 dry-run；`--write-plan` 输出计划；`--apply` 需 `MIGRATION_CONFIRM=media-v2`。
- 流程：复制 R2 对象（S3 CopyObject）→ 分批 `media/import-v2` → 逐篇重写 frontmatter。
- `scripts/media/plan-v2.mjs` + `tests/migrate-v2-plan.mjs` 覆盖 ID、复制对、文章引用。
- 迁移文档：`docs/media-v2.md`；旧 key 不删除，文章可按提交回滚。

## P2 第四批（编辑器接入）

- 编辑器新增「从素材库选择」：列出 v2 资产、预览、选择后插入正文占位符，并写入 frontmatter `media`。
- `getEditorMedia()` 合并 v2 引用，块预览/插入索引校验不再只依赖旧 slug 媒体。
- 保存请求携带 `frontMatter.media`；admin-local 断言保存 payload 与占位符。
- 素材库缩略图走 `/api/assets/:id/preview`；封面预览支持 assetId。
- 素材详情：生命周期/健康原因、复制 ID、软删除（7 天）与恢复；素材库新增「待删除」筛选。

## P4 第一批（云草稿）

- R2 草稿：`POST/GET/PUT/DELETE /api/drafts`，revision 乐观并发，保存前写上一版快照。
- `POST /api/drafts/:id/publish`：发布才写 Git，成功后删除云草稿；沿用文章 `baseSha` 冲突。
- 编辑器：
  - `#editor&draft=<id>` 进入草稿模式；保存只更新 R2，发布才写文章。
  - 编辑已发布文章时，本地保存会同步云端草稿；发布成功后清理云草稿。
  - 云端草稿加载/恢复/丢弃横幅。
- 新增 `#drafts` 草稿列表：继续写、删除、新建。
- 测试：`tests/drafts-api.mjs`（创建/保存/冲突/列表/删除/发布）；admin-local 覆盖草稿模式保存与发布。

## P4 第二批（私密预览）

- `POST /api/previews` 创建 `prv_`，派发 `preview.yml`；`GET /api/previews/:id` 轮询状态。
- 预览访问：`/api/preview/<token>/`，HMAC 24h，R2 `previews/<id>/`，`noindex`/`no-store`。
- 预览构建：Actions 用一次性 build token 读草稿 → 写内容 → `npm run build` → 上传 R2 → 回调状态。
- 编辑器草稿模式新增「预览文章」，轮询完成后 toast 打开。
- 新增 `scripts/preview/{write-draft,upload}.mjs`、`.github/workflows/preview.yml`、`docs/preview.md`、`tests/preview-api.mjs`。
- 未真实触发 Actions；需要 R2/Worker 凭据与 `PREVIEW_SECRET`。

## P5 第一批（视频增强）

- `POST /api/media/interpolate` 扩展 `assetIds`、`operation`、`sourceMode`、`reencode`；兼容旧 slug/all。
- Jobs 选项保留 `operation/sourceMode/reencode`；`reencode` 关闭插值但强制重新编码。
- `original` 来源要求原文件可用；`processed` 来源要求已发布分层。
- 新页面 `#enhance`：视频选择、三种操作、来源、帧率、CRF/preset/音频码率。
- 新增 `tests/enhance-jobs.mjs`（三种操作、两种来源、参数拒绝）、`docs/video-enhance.md`。

## P6 第一批（主题包）

- 主题契约 `shared/theme.mjs`：id 校验、manifest、选项 schema、默认值合并与校验。
- 构建 `scripts/site/theme.mjs`：default 复用 `src/layouts`，外部主题用 `themes/<id>/layouts` + `assets/` → `dist/theme/`。
- 默认主题微调：accent、defaultMode、showThemeMenu、allowVisitorToggle 映射到 `themeMode`。
- 新增 `themes/default/theme.json` 和完整示例 `themes/starter/`（三份 EJS + CSS）。
- 后台 `#themes`：主题卡片、动态选项表单、应用；`GET /api/themes`、`POST /api/themes/apply`。
- 测试：`theme-smoke`（契约/解析/default/starter）、`themes-api`（列表/应用/校验）；admin-local 12 页 axe。
- 文档：`docs/themes.md`。

## P7 第一批（版本历史）

- `GET /api/history`、`GET /api/history/:sha`、`POST /api/history/:sha/restore`。
- 恢复基于 GitHub Contents API，创建新提交，不改写历史；最多 20 个文件/次。
- 后台 `#history`：提交列表、文件 patch、恢复整次/单文件。
- 测试：`tests/history-api.mjs`；admin-local 历史页 axe。
- 文档：`docs/history.md`。

## P8 收口进度

- P3：任务中心显示 `kind/operation/sourceMode`；清理页可清理到期素材和过期预览；资产生命周期支持当前 + 上一代回滚。
- P1：设置页保存头吸顶；上线页移除媒体任务面板，任务统一到任务中心。
- P4：预览过期清理；`previews/` 不再无限增长。
- 真实迁移/预览 Actions 仍需凭据联调；未在本地执行 R2 迁移。

## 文档索引

- [Media v2 与迁移](../media-v2.md)
- [私密预览](../preview.md)
- [视频增强](../video-enhance.md)
- [主题包开发](../themes.md)
- [版本历史](../history.md)

## 最终验证命令

```bash
npm run test:unit
node tests/admin-local.mjs
ADMIN_SHOTS=/tmp/mosaic-shots node tests/admin-local.mjs
npm run build
SITE_THEME_PACKAGE=starter npm run build
```

真实环境还需要：

1. `migrate-v2.mjs --write-plan` 核对后 `--apply`（R2/Worker 凭据）。
2. 触发一次 `preview.yml`，确认草稿读取、R2 上传、状态回调。
3. 主题页应用一次，确认 config 提交与构建。

## 截图

- [概览（亮）](../screenshots/dashboard-light.png)
- [概览（暗）](../screenshots/dashboard-dark.png)
- [编辑器](../screenshots/editor-light.png)
- [主题](../screenshots/themes-light.png)
- [素材库](../screenshots/library-light.png)

由 `ADMIN_SHOTS=/tmp/mosaic-shots node tests/admin-local.mjs` 生成。
