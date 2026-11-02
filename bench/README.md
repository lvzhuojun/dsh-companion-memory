# bench

中文陪伴记忆评测。评测方法、题型、打分表与复现命令见 [`docs/benchmark.md`](../docs/benchmark.md)；这里只是目录索引。

所有题集里的人物、对话、日记都是程序生成或手写的**虚构**内容。剧本里主人被称作“老大”，这是虚构世界的设定，不对应任何真实的人。

| 目录 | 内容 | 入口 |
|---|---|---|
| `lifesim/` | **LifeSim**：确定性生成的 100 天虚构生活与题目（事实、更新、时间、承诺、拒伪、隐私、遗忘、惦记、危机等）；快速档 / 完整档、写入侧四率、配对比较与成本曲线 | `npm run bench:lifesim -- …`，见 [`docs/benchmark.md` 第 1、2、6 节](../docs/benchmark.md) |
| `rubric/` | 打分表 v3：门槛 → 帕累托 → 1-SE 膝点 → 扰动检验（离线，不调模型） | `npm run bench:score -- …` |
| `membench/` | 记忆基准命令行与对照系统（无记忆、全文、BM25、本仓库、dsh-fish-memory、mem0 桥接）、LoCoMo 适配器 | `npx tsx bench/membench/cli.ts` |
| `synth/` | 中文陪伴题集 S：120 天虚构生活、200 题；每题证据链由单测核对 | `npm run bench:p0 -- --dataset synth --qq` |
| `p0/` | 伪记忆题集 P0：50 题，测“不记得就说不记得”“说记下了就真的记了”；关键词判分 + 离线重判 | `npm run bench:p0`、`npm run bench:p0:rescore -- <结果 json>` |
| `micro/` | 微基准：思考强度切换与前缀缓存、大前缀 + 相似干扰项 | `npx tsx bench/micro/<脚本>.ts` |
| `compaction/` | 中文陪伴版压缩指令试跑（虚构对话） | `npx tsx bench/compaction/try.ts` |

## 运行

```bash
npm ci && npm run build          # 评测用的是 dist，改了源码先 build
npm test                         # 离线单测：世界生成、证据链、判分都有单测

export BENCH_BASE_URL=<Anthropic 兼容接口地址，不含 /v1/messages>
export BENCH_API_KEY=<你的 key>   # 只放环境变量，不要写进文件或贴进 issue
export BENCH_MODEL=deepseek-flash # 可选；BENCH_EFFORT 默认 low；BENCH_OUT 默认 bench/results
```

结果写到 `bench/results/`（已 gitignore）。LoCoMo 数据许可为 CC BY-NC，不随仓库分发，用 `LOCOMO_PATH` 指向本地文件。

## 约定

- 题集只放生成器、题型定义与判分代码；任何真实对话、日记都不进仓库。
- 判分规则改了以后，先用离线重判在旧结果上对比（不调模型），再跑新的。
- 统计方法（置信区间、小样本纪律、保留世界只跑一次）见 [`docs/benchmark.md` 第 4 节](../docs/benchmark.md#4-统计方法)。
