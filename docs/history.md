# 版本历史

版本历史直接使用 GitHub 提交，不引入数据库。后台显示最近提交、文件级 diff，并允许恢复。

## API

- `GET /api/history?limit=30`：最近提交（最多 100）。
- `GET /api/history/:sha`：提交详情 + 文件 patch。
- `POST /api/history/:sha/restore`：恢复整次提交；body `{ "path": "content/posts/x/index.md" }` 只恢复一个文件。

## 恢复语义

- 恢复**创建新提交**，不改写历史，因此可以再次恢复。
- 修改/新增文件：读取该提交里的 blob，写回当前分支。
- 删除文件：读取该提交时删除的文件，在当前分支删除。
- 单次最多恢复 20 个文件；部分失败会返回 `ok:false` 和逐文件状态。
- 恢复完成后标记 dirty；到「上线」构建后生效。

## 限制

- 二进制文件的 diff 不显示；恢复仍按 blob 写回。
- 整次提交恢复不是 `git revert`：如果之后的提交也改了同一文件，会以所选提交的内容覆盖当前文件。
- 提交列表来自 GitHub API，受 token 权限与速率限制影响。
