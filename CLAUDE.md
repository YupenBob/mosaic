# Mosaic Project Principles

## 核心准则

**Mosaic 是一个站点生成器框架原型（类似 Hexo），不是一次性网站。**
所有设计决策必须以"未来数千用户开箱即用"为出发点。

### 1. 永远不本地手动传资源

媒体文件（图片/视频/音频）从设计之初就不走本地。完整链路必须是：

```
Admin 上传 → R2 originals/ → GitHub Actions 压缩 → R2 processed/ → CF Pages 展示
```

**禁止**用 Playwright、curl、Node 脚本等从本地上传文件到 R2 来绕过 pipeline bug。
**必须**从根源修复 pipeline（pipeline.yml、compress 脚本、上传配置）。

### 2. 修复问题从根源，不贴膏药

- Pipeline 断在哪一步就修哪一步
- 不靠手动操作弥补自动化缺陷
- 每一个 workaround 都是未来用户的坑

### 3. 本地只做代码改动

- `scripts/`、`src/`、`worker/`、`cloud-admin/` 等代码文件可以本地编辑后推送
- `dist/`、`content/posts/` 中的媒体资源由 pipeline 生成，不手动干预

### 4. 测试标准

- 功能验证优先通过 CI/CD 自动化
- 手动测试只用于 UI/UX 体验
- "能跑了"不等于"完工了"——全流程自动化才是

## 技术架构

- **内容管理**：GitHub Repo（Markdown + frontmatter）
- **媒体存储**：Cloudflare R2（originals/ + processed/）
- **计算层**：GitHub Actions（压缩、转码、构建）
- **API 层**：Cloudflare Workers（认证、预签名上传、文章/配置/构建、Durable Object 统计）
- **前端**：Cloudflare Pages（静态站点 + Pages Functions 代理）
- **管理面板**：Cloudflare Pages（独立项目 mosaic-admin）
- **媒体管线**：originals → 压缩/转码 → processed；EXIF 自动剥离；checksum 缓存 + 产物清单实现增量构建
- **自动化**：管线内置测试，`health-check.yml` 定期巡检线上
