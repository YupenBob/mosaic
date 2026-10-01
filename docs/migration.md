# 迁移与回退

此分支保留旧文章地址、内容块语法、Stats DO 和代理同步契约。不要先启用新的站点工作流再部署任务 Worker，否则无法取得已发布清单。

## 上线顺序

1. 保存当前 Pages 部署 ID、Git SHA 和 R2 `site-data/media-checksums.json`、旧 `posts.json`。保留旧工作流版本。配置相同的 Actions/Worker `PIPELINE_SECRET`，核对桶、Worker 名称、Pages 项目、分支和 CORS。
2. 在站点自动发布暂停期间先运行 `Mosaic Infrastructure`：保留 STATS/v1，增加 JOBS/v2-media-jobs，配置两份 Pages 的 `API_TARGET`，再发布后台。默认生产分支为 main，feature 分支只做离线检查。
3. 启动 `Mosaic Media`。迁移脚本分页列出 originals，读取旧 checksum 清单，HEAD 核验图片、视频 MP4/播放列表/所有分片、海报、音乐与元数据。有效旧产物立即导入，不要求重编码；缺失项登记待处理任务。
4. 检查迁移标记 `site-data/media-migration-v1.json` 和媒体任务列表。视频旧 master 引用了缺失档位时只保留已验证 MP4，不宣称无效 HLS 就绪。媒体工作流仅下载排队文件。
5. 启用新的 `Mosaic Site`，获取 DO 固定清单快照并构建、验证、部署，再写入精简列表缓存和签名确认。允许媒体低档更新自动调度站点，站点完成不会调度转码。
6. 保留 `dist/data/posts.json` 与 Worker 旧 `site-data/posts.json` 读取适配一个发布周期，确认所有列表消费者切换后再移除兼容入口。

`infrastructure.yml`、`media.yml`、`pipeline.yml` 使用独立并发组，取消设置为 false。同一分支操作串行；GitHub 仅保留一个待执行并发 run，DO outbox 和租约到期会补调未完成媒体任务。

生产默认启用 `REQUIRE_MEDIA_MIGRATION`。未完成导入时，站点 begin 返回 503 并保留上一部署；不要通过关闭保护来跳过迁移。

## 清单与回退

当前清单位于可配置 `media.manifestKey`；每次修改另写 `site-data/media-manifests/{revision}.json`。DO 保留最近成功部署，包括 Git SHA、清单版本和时间。正在构建及保留部署引用的产物不能被后台或媒体清理删除。

回退时先停止新的媒体调度/取消对应任务，在 Pages 选择上一成功部署，并使用该部署记录的清单快照和源码 SHA 做后续重建。不要把旧 master 写回新 generation，也不要直接删除当前清单。需要恢复旧流程时恢复旧 Git SHA/workflow，保留 JOBS 命名空间和 STATS 数据；清单、原文件和上一部署均保留。

迁移失败不写完成标记，下次媒体工作流重新核验与幂等导入。自动重试耗尽的文件可在后台逐一重试；配置变化和同名替换会撤销旧任务，旧回调不能重新发布。

## 本次交付边界

代码、工作流、离线测试与部署脚本在 `codex/project-refactor` 上交付。生产 Secret 配置、迁移核验及线上流程切换必须按上述兼容顺序执行；本地验证不会读生产凭据或上传用户媒体。未跟踪宣传视频目录与备份脚本不纳入本次业务提交。
