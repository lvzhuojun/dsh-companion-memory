# 参与贡献 / Contributing

欢迎 issue 和 PR，中文、英文都可以。Issues and PRs are welcome, in Chinese or English.

## 开始 / Getting started

```bash
npm ci            # 需要 Node.js ≥ 22.12；会自动启用提交前的防泄露扫描钩子
npm run build     # 编译 packages/*（评测与打包用的是 dist，改了源码先 build）
npm run check     # 防泄露扫描 + 类型检查 + 单元测试（离线，不调模型）
```

## 约定 / Conventions

- **新机制做成默认关闭的开关。** 关闭时输出必须与之前逐字节一致，并附单元测试。开关字母与配置键见 [`docs/architecture.md` 第 5 节](docs/architecture.md#5-开关一览)。
- **代码只给信息和时机，不给台词。** 尽量不要往提示词里堆规则；评测里有“套话率”指标。
- **她写下的东西不被改写。** 记忆正文、日记、人物卡写下后不能改、不能删（数据库触发器保证）；系统只能附加元数据。
- **宣称“更好”要有证据。** 附配对比较（同一世界、同一题号），按 [`docs/benchmark.md`](docs/benchmark.md) 的打分表报告；不显著的差距不说“更好”。判分规则改了，先在旧结果上离线重判。
- **双语文档。** `README` 与 `docs/` 下的中文文档改了，对应的 `.en.md` 一起改。
- **只改注释 / 文档的 PR 不改行为。**

## 隐私与安全 / Privacy & security

- 不要提交任何真实对话、日记、`self.md` / `seed.md`、记忆库、会话日志、密钥、服务器地址或账号。`.gitignore`、提交前钩子与 CI 里的 `scripts/scan-instance.mjs` 会拦，但请先自己确认。
- 本地可以建 `private/instance-patterns.txt`（已 gitignore），每行一个你自己的实例字面量（服务器地址、账号等），扫描器会一并检查。
- 安全问题请不要开公开 issue，按 [`SECURITY.md`](SECURITY.md) 走 GitHub 私密报告。

## 许可 / License

提交即表示你同意以 [Apache-2.0](LICENSE) 授权你的贡献。By contributing you agree to license your contribution under Apache-2.0.
