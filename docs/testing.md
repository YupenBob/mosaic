# Mosaic 测试指南

测试集中在 `tests/` 目录。原则：功能验证优先走 CI/CD 自动化，手动测试只用于 UI/UX 体验。

## 本地测试

### 静态检查

```bash
node --check scripts/compress.js scripts/generate.js scripts/upload.js
```

### Worker 冒烟（无需网络/凭据）

```bash
node tests/worker-smoke.mjs
```

用内存 Mock 模拟 R2 与 GitHub，覆盖：登录与限流、fail-closed、track/dwell/stats、并发视图序列化、config 深合并、媒体删除、分类/标签重命名、上传鉴权/大小限制、预签名 URL 与 complete、R2 文章列表缓存。

### 站点 E2E（Playwright）

生产模式（默认，针对线上域名）：

```bash
node tests/check-site.mjs
npx playwright test tests/frontend.spec.js --reporter=list
```

本地模式（先 `npm run serve` 起 dist，Worker 可选 `wrangler dev`）：

```bash
SITE=http://localhost:3000 ADMIN=skip API=http://localhost:8787 node tests/check-site.mjs --local
```

`check-site.mjs` 覆盖：健康检查、首页、分类页样式（相对路径回归）、媒体 URL 直连 R2、管理面板加载。

`frontend.spec.js` 覆盖：首页、图片直连、分类样式、Worker 健康、**移动端 HLS 起播**（390×844 视口，断言直连 URL + CORS 头）、管理面板登录。

### Admin 端到端（真实登录）

```bash
node tests/admin-smoke.mjs   # 或 npm run test:admin
```

已接入 `npm run check`：本地读取 `worker/.dev.vars` 中的 `ADMIN_PASSWORD` 登录后台，验证仪表盘与文章列表渲染；CI 无凭证时自动跳过。`ADMIN_URL` 环境变量可覆盖目标地址。需要网络与有效密码。

## CI 集成

### 构建管线（pipeline.yml）

每次构建自动执行：

```bash
npm run check             # node --check 全部脚本 + proxy 同步校验 + config 校验 + worker-smoke + admin-smoke + build-smoke
npm run lint              # ESLint（0 警告）
npm run format:check      # Prettier 格式校验
npx playwright install --with-deps chromium
SITE=http://127.0.0.1:3000 ADMIN=skip npx playwright test tests/frontend.spec.js \
  --grep-invert "Worker health|mobile viewport|admin login"   # CI 含移动端 HLS；本地无媒体清单时跳过

> 说明：移动端 HLS 用例在管线内执行（CI 会从 R2 同步媒体并恢复清单，dist 含 HLS 引用）；
> 本地 `npm run test:e2e:local` 因没有本地媒体文件而排除该用例。
```

任何失败都会中断构建，阻止部署。本地等价命令：`npm run check`、`npm run validate`、`npm run lint`、`npm run format:check`、`npm run test:e2e:local`（先 `npm run build`）。

### 生产健康检查（health-check.yml）

每 6 小时对线上域名运行 `node tests/check-site.mjs`；失败会触发 GitHub Actions 告警。可手动 `workflow_dispatch` 触发。

## 验收口径

- 所有断言通过即视为该模块验收通过
- 移动端 HLS 测试以"播放列表 200 + `Access-Control-Allow-Origin: *` + hls.js 加载"为口径
- 涉及生产数据的测试（配置写入、媒体删除等）只在本地的 worker-smoke Mock 中执行，不在线上跑

## 常见问题

- **Playwright 浏览器缺失**：`npx playwright install chromium`
- **`convertFromJson` 报错**：PowerShell 5.1 对大 JSON 有限制，改用 Node 或 `jq`
- **本地无媒体**：`npm run compress` 会跳过，生成仅文本页面；完整媒体行为以 CI 为准
