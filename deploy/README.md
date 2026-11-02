# deploy

部署相关的两个小程序。完整步骤（打包插件、预设、夜间整理配置、迁移、回滚、安全建议）见 [`docs/deploy.md`](../docs/deploy.md)。

| 目录 | 内容 |
|---|---|
| `night/` | 夜间整理入口 `night-review.ts` 与打包脚本 `pack.mjs`。`npm run deploy:night:pack` 打成单文件 `out/night/night-review.mjs`；配置与定时见 [`docs/deploy.md` 第 4 节](../docs/deploy.md#4-夜间整理) |
| `migrate/` | 0.7 迁移 `0.7.mjs`：在线备份 → 加列建表 → 给已有条目回填键 → 完整性检查；支持 `--dry-run`。用法见 [`docs/deploy.md` 第 5 节](../docs/deploy.md#5-升级到-07-与迁移) |

约定：

- 产物写到 `out/`（已 gitignore），不进仓库。
- 脚本只打印数字、状态和原因；不打印令牌、联系方式、对话或记忆正文。
- 提交前跑 `npm run scan`。
