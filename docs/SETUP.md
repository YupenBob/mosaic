# Mosaic 从零搭建指南

## 架构概览

```
┌──────────────┐    ┌─────────────────┐    ┌──────────────┐
│ Cloud Admin   │───▶│  Worker API     │───▶│  GitHub API  │
│ (CF Pages)    │    │  (CF Workers)   │    │  (内容仓库)   │
└──────────────┘    └───────┬─────────┘    └──────────────┘
                            │
                     ┌──────▼─────────┐
                     │  R2 Storage     │
                     │  (媒体存储)     │
                     └────────────────┘

┌──────────────────────────────────────────────────────┐
│                  GitHub Actions CI/CD                 │
│  push → sync R2 → 压缩 → build → upload R2 → deploy │
└──────────────────────────────────────────────────────┘

┌──────────────┐
│  前台站点     │
│  (CF Pages)  │  ← 纯静态 HTML/CSS/JS，媒体走 R2
└──────────────┘
```

## 前置条件

- **Node.js** 20+
- **Git** + GitHub 账号
- **Cloudflare 账号**（R2、Pages、Workers）
- **FFmpeg**（视频压缩，CI 中自动安装）

---

## 第一步：克隆项目

```bash
git clone https://github.com/YupenBob/mosaic.git
cd mosaic
npm install
```

## 第二步：本地跑通

```bash
# 压缩媒体（本地无媒体可跳过）
npm run compress

# 构建站点
npm run build

# 本地预览
npm run serve
# 打开 http://localhost:3000
```

生成的站点在 `dist/` 目录下，是纯静态文件。现在还没用到 R2 和 Worker。

---

## 第三步：Cloudflare 配置

### 3.1 创建 R2 存储桶

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → R2
2. 创建存储桶，名称：`mosaic-media`
3. 位置选 `Automatic`

### 3.2 创建 API Token

1. Cloudflare Dashboard → 右上角头像 → **My Profile** → **API Tokens**
2. 创建 token，权限选：
   - **Account** — **Workers Scripts** — **Edit**
   - **Account** — **Cloudflare Pages** — **Edit**
   - **Account** — **R2 Storage** — **Edit**
3. 记下 token 值和你的 **Account ID**

### 3.3 获取 R2 S3 凭据

1. R2 → `mosaic-media` → **Settings** → **R2 API Tokens**
2. 创建 token，权限 **Object Read & Write**
3. 记下 `Access Key ID` + `Secret Access Key`
4. R2 Endpoint: `https://{ACCOUNT_ID}.r2.cloudflarestorage.com`

---

## 第四步：部署 Worker API

```bash
cd worker
npm install
```

### 4.1 创建 GitHub Personal Access Token

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. 选择仓库 `YupenBob/mosaic`
3. 权限：
   - **Contents** — Read and Write（读写文章）
   - **Actions** — Read and Write（触发构建）
4. 记下 token 值

### 4.2 设置 Worker Secrets

```bash
# 在 worker/ 目录下运行：
npx wrangler secret put ADMIN_PASSWORD     # 管理员密码
npx wrangler secret put JWT_SECRET         # 随便生成的长字符串（openssl rand -hex 32）
npx wrangler secret put GITHUB_TOKEN       # 上面创建的 GitHub token
npx wrangler secret put CF_ACCOUNT_ID      # Cloudflare Account ID
npx wrangler secret put R2_ACCESS_KEY      # R2 S3 Access Key
npx wrangler secret put R2_SECRET_KEY      # R2 S3 Secret Key
```

### 4.3 部署

```bash
npx wrangler deploy
```

部署后 Worker URL 类似：`https://mosaic-api.你的用户名.workers.dev`

验证：打开 `https://mosaic-api.你的用户名.workers.dev/api/health`，应返回 `{"status":"ok",...}`

---

## 第五步：配置 R2 CORS

```bash
# 在 worker/ 目录下：
npx wrangler r2 bucket cors set mosaic-media --file r2-cors.json -y
```

`r2-cors.json` 内容：
```json
{
  "rules": [
    {
      "allowedOrigins": ["*"],
      "allowedMethods": ["PUT", "GET"],
      "allowedHeaders": ["*"],
      "maxAgeSeconds": 3600
    }
  ]
}
```

---

## 第六步：部署 Cloud Admin（后台管理面板）

```bash
cd cloud-admin
```

`cloud-admin/index.html` 中 `window.__API_BASE__ = '/api'` 保持默认即可：
`cloud-admin/functions/api/[[path]].js`（Pages Functions 代理）会把 `/api/*`
转发到 Worker 自定义域名 `https://mosaic-api.xsanye.cn`，无需改前端代码。

```bash
npx wrangler pages project create mosaic-admin --production-branch main
npx wrangler pages deploy ./
```

部署后管理面板 URL：`https://mosaic-admin.pages.dev`

---

## 第七步：配置 GitHub Actions

去 `https://github.com/YupenBob/mosaic/settings/secrets/actions` 添加：

| Secret 名 | 值 |
|-----------|-----|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `R2_ACCESS_KEY` | R2 S3 Access Key |
| `R2_SECRET_KEY` | R2 S3 Secret Key |
| `R2_ENDPOINT` | `https://{ACCOUNT_ID}.r2.cloudflarestorage.com` |

Setting these secrets enables the CI/CD pipeline to:
1. Download media from R2
2. Compress and process media
3. Build the static site
4. Upload processed media back to R2
5. Deploy the site to Cloudflare Pages

After setting all secrets, go to:

```bash
npx wrangler pages project create mosaic --production-branch main
```

This creates the Cloudflare Pages project for the frontend site. The default domain will be `https://mosaic-xxx.pages.dev`.

---

## Step 8: First Build & Deploy

Push a test commit or use the admin panel:

1. Open `https://mosaic-admin.pages.dev`
2. Log in with your admin password
3. The Dashboard will show your post count and health status
4. Go to **Editor** to create or edit posts
5. Upload media using the drag-and-drop zone at the bottom of the editor
6. Go to **Build** and click "Build & Deploy"

The build runs on GitHub Actions and takes 5–15 minutes depending on media volume. Check progress on the Build page or at `https://github.com/YupenBob/mosaic/actions`.

---

## Step 9: Verify

1. Open your CF Pages domain (e.g. `https://mosaic-xxx.pages.dev`)
2. Check that posts display with images and videos
3. Right-click an image → Copy Link → should be `https://mosaic-media.xsanye.cn/processed/...`
   （或 `config.mediaBase` 配置的 R2 直连域名）
4. Verify the admin panel can create/edit posts and trigger builds

---

## Step 10: Comments (Optional)

1. Go to `https://github.com/YupenBob/mosaic/discussions` and enable Discussions
2. Go to `https://giscus.app` and configure for your repo
3. Copy your `repoId` and `categoryId`
4. Fill in `mosaic.config.json` under `giscus`:
```json
"giscus": {
  "repo": "YupenBob/mosaic",
  "repoId": "R_kgDO...",
  "category": "Announcements",
  "categoryId": "DIC_kwDO..."
}
```
5. Also set `"components": { "comments": { "enabled": true, "provider": "giscus" } }`
6. Commit and push — the next build will include comments

---

## 日常使用流程

```
打开管理面板 → 创建/编辑文章 → 上传媒体 → 保存 → Build & Deploy
                                                              │
                                                              ▼
                                                     GitHub Actions 构建
                                                     (同步 R2 → 压缩 → 生成 → 部署)
                                                              │
                                                              ▼
                                                     前台站点更新 ✅
```

## 目录结构

```
mosaic/
├── content/posts/       # 文章（Markdown + frontmatter），一个目录一篇文章
│   └── my-post/
│       ├── index.md     # 文章正文 + YAML frontmatter
│       ├── photos/      # 图片原片
│       └── videos/      # 视频原片
├── scripts/             # 构建脚本
├── src/                 # 模板和前端资源
│   ├── assets/          # CSS, JS, 图片
│   ├── layouts/         # EJS 模板
│   └── data/            # 翻译文件
├── worker/              # Cloudflare Worker API
├── cloud-admin/         # 云端管理面板 SPA
├── admin/               # 本地管理面板（开发用）
└── mosaic.config.json   # 站点配置
```
