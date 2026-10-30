# Mosaic 后台重构执行日志

计划：`Mosaic 后台重构执行计划 v3.1`（Media v2、草稿/预览、主题、视频增强、任务中心、资产生命周期、版本历史、界面重构）。

当前阶段：**P1 框架/视觉/动效/预览图（进行中）**

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| P0 安全热修 | 完成 | `validSegment`、`jsStr`、`baseSha`、XSS 回归 |
| P1 框架/视觉/动效/预览图 | 进行中 | 壳层、状态胶囊、账户菜单、动效、概览、文章筛选、编辑器两栏、预览图 |
| P2 Media v2 | 未开始 | |
| P3 任务中心/生命周期 | 进行中 | 任务中心页已基于现有 `/api/media-jobs` 落地；资产生命周期待 Media v2 |
| P4 草稿/预览 | 未开始 | |
| P5 视频增强 | 未开始 | |
| P6 主题系统 | 未开始 | |
| P7 版本历史 | 未开始 | |
| P8 收口 | 未开始 | |

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
