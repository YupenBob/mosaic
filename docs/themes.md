# 主题包

Mosaic 的主题是 `themes/<id>/` 下的一个目录，构建时由 EJS 渲染。主题是**受信任代码**：EJS 模板可以执行 JavaScript，只安装你审查过的主题。后台不上传/执行任意主题，安装主题等于往仓库提交文件。

## 目录

```
themes/<id>/
  theme.json
  layouts/
    index.ejs
    post.ejs
    404.ejs
  assets/          # 可选，复制到 dist/theme/
```

内置 `default` 主题的布局仍在 `src/layouts`；`themes/default/theme.json` 只描述默认主题的微调项。

## theme.json

```json
{
  "id": "starter",
  "name": "Starter",
  "version": "1.0.0",
  "description": "…",
  "engine": "ejs",
  "layouts": {
    "index.ejs": "layouts/index.ejs",
    "post.ejs": "layouts/post.ejs",
    "404.ejs": "layouts/404.ejs"
  },
  "options": {
    "accent": {
      "type": "color",
      "default": "#4361ee",
      "label": "强调色",
      "description": "链接和标题装饰色。"
    }
  }
}
```

- `id` 必须与目录名一致，小写字母/数字/连字符。
- `layouts` 可省略，默认 `layouts/<name>`。
- `options` 支持 `select`、`boolean`、`text`、`number`、`color`。
- 选项值保存在 `mosaic.config.json` 的 `themeOptions`，构建时以 `theme.options` 暴露。

## 模板数据

每个模板都能拿到：

| 变量 | 说明 |
| --- | --- |
| `site` | 合并后的站点配置；`site.title`、`site.description`、`site.url` 等 |
| `theme` | `{ id, name, version, options }` |
| `t(key)` | 站点语言文案 |
| `rp` | 从当前页面回 dist 根的前缀，例如 `../../` |
| `posts` | 当前页文章数组 |
| `post` | 文章详情页对象：`title/slug/date/category/tags/description/bodyHTML/cover/photos/videos/music` |
| `categories` / `tags` | 分类/标签索引 |
| `renderCard` / `renderCards` | 默认卡片渲染器，可选 |
| `pageTitle` / `pageDescription` / `currentPage` / `totalPages` / `prev` / `next` | 页面上下文 |

`bodyHTML` 已是站内 Markdown/媒体块的 HTML，可直接 `<%- post.bodyHTML %>`。

## 资源

`themes/<id>/assets/**` 会复制到 `dist/theme/**`。模板里用：

```html
<link rel="stylesheet" href="<%= rp %>theme/theme.css" />
```

## 安装与切换

1. 把主题目录提交到仓库。
2. 后台「主题」页读取 `themes/*/theme.json`，选择并保存选项。
3. 保存会提交 `mosaic.config.json` 的 `themePackage`/`themeOptions`。
4. 到「上线」构建后生效。

## 默认主题微调

`themes/default/theme.json` 暴露：

- `accent`：blue/violet/emerald/rose/amber/slate
- `defaultMode`：auto/light/dark
- `showThemeMenu`：是否显示前台主题菜单
- `allowVisitorToggle`：是否允许访客切换

这些值会映射到现有 `themeMode`，不改变默认主题的布局。

## 写一个最小主题

复制 `themes/starter/`，改 `theme.json` 和三份 layouts。构建验证：

```bash
SITE_THEME_PACKAGE=starter npm run build
```

生产环境用后台主题页切换；`SITE_THEME_PACKAGE` 只用于本地/CI 覆盖。
