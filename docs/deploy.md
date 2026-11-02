# 部署

> 中文 | [English](deploy.en.md)

本文是把记忆系统作为 DSH 插件部署的通用步骤：打包、预设、配置、夜间整理、0.7 迁移、升级与回滚，以及安全建议。路径都是示例，请换成你自己的。

## 1. 前提

- 已经装好并能运行的 DeepSeek Harness（DSH），以及一个要挂记忆的 profile。
- Node.js ≥ 22.12（用内置的 `node:sqlite`）。夜间整理要读 DSH 压缩过的会话日志，Node 还需要支持 `zlib.zstdDecompressSync`。
- 一个 **Anthropic 兼容**的模型接口（夜间整理调用 `<baseUrl>/v1/messages`）。我们的评测都在 deepseek-flash 上做。
- 一个专门的系统用户运行 DSH；生命目录（日记、`self.md`、`memory.db`）只有这个用户能读写。

## 2. 打包与安装插件

```bash
npm ci
npm run build                                   # 编译 packages/*（插件打包用的是 dist）
npm run bundle -w @dsh-companion/dsh-plugin     # → packages/dsh-plugin/bundle/：lib/index.js、lib/compaction.js、package.json
```

产物是零依赖的单文件插件，包名 `dsh-her-life`。预设（第 3 节，完整模板见 [`templates/cordis.patch.example.yml`](../templates/cordis.patch.example.yml)）要放在 `packages/dsh-plugin/bundle/cordis.patch.yml`（包的 `package.json` 用 `dsh.bundle.patch` 指向它）：打包时加 `-- --patch <你的预设文件>` 会自动拷进去，也可以打包后手动放。然后：

```bash
cd packages/dsh-plugin/bundle
npm pack                                        # → dsh-her-life-<版本>.tgz
dsh plugin --profile <profile> add ./dsh-her-life-<版本>.tgz
```

`dsh plugin add` 把参数交给 pnpm，所以本地 tgz、tgz 的下载地址都可以装。monorepo 里的子包源码不能直接装（TypeScript、依赖同仓库的包），一定要装打包好的版本。装好后重启 DSH，日志里会看到一行 `[her-life] 已挂载：…` 和每个开关的开关状态。

## 3. 预设

```yaml
- insert:
    - id: preset-companion
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: companion
        name: 陪伴
        description: 带长期记忆的陪伴会话
        plugins:
          - id: her-life
            name: 'dsh-her-life'
            config:
              seedPath: /srv/companion/seed.md       # 种子：root 所有、0644，她只能读
              lifeDir: /home/companion/life          # 生命目录：self.md、diary/、proposals/、memory.db
              ownerName: 主人
              ownerBook: to_owner
              variablePrefix: companion
              privateDiaryAudited: false
              blockTools: [qq_bridge_napcat]         # 这个会话里不该用的全局工具
              # 读侧
              askFirst: true                         # C
              timeCalc: true                         # D
              prerecall: true                        # R
              followTrigger: true                    # K
              followUpLoose: true                    # F
              followUpWeight: true                   # W
              memoryKeys: true                       # S
              # 0.7
              memorySlots: true                      # Y
              personCard: true                       # T
              # crisis: true                         # Z：见第 6 节
              # emergencyContact: '<只写在私有预设里>'
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: "{{companion_seed}}\n\n---\n\n# 我是谁\n\n{{companion_self}}\n\n---\n\n{{companion_memory}}"
              complete: true
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
            config:
              - id: compaction-basic
                name: 'dsh-her-life/compaction'      # 可选：中文陪伴版压缩；换回 '@deepseek-ai/dsh-compaction-basic' 即用默认
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
```

- 三个提示词变量：`{{<前缀>_seed}}`（种子）、`{{<前缀>_self}}`（她自己写的 self.md）、`{{<前缀>_memory}}`（记忆规则 + 稳定层）。前缀由 `variablePrefix` 决定，预设里的 `prefix` 要用同一个前缀。
- `dsh-her-life/compaction` 是中文陪伴版压缩：子类化 DSH 的 compaction-basic、只换摘要指令，配置项（`thresholdRatio`、`retainTokens`）完全相同。拿不到 compaction-basic 时它不接管、只打警告。
- 每个配置键与开关的含义见 [`architecture.md` 第 5 节](architecture.md#5-开关一览)。所有开关默认关；成对的开关（S、Y、T、K、F、W）夜间整理那边也要一起开。
- 种子模板见 [`templates/seed.template.md`](../templates/seed.template.md)。种子在“出生”后不再修改；她是谁由她自己在 self.md 里写，修改走 `propose_self_change` 的待审区。

## 4. 夜间整理

夜间整理是一个独立的小程序，每晚在设定的时段里跑一次：读当天的会话日志，让她以第一人称回顾这一天，写记忆、惦记、日记和人物卡。

### 4.1 打包

```bash
npm run deploy:night:pack        # tsc -b 后用 esbuild 把 deploy/night/night-review.ts 打成单文件 night-review.mjs
```

### 4.2 配置（`config.json`）

| 键 | 必填 | 说明 |
|---|---|---|
| `lifeDir` | 是 | 生命目录（和插件的 `lifeDir` 相同） |
| `sessionLog` | 是 | 她那个会话的日志文件（DSH 数据目录下 `sessions/…/<会话>/session.v4.jsonl.zstd`） |
| `sessionId` | 是 | 会话 id（用作回顾游标的键） |
| `ownerName` / `ownerBook` / `privateDiaryAudited` | 是 | 和插件预设保持一致 |
| `baseUrl` | 是 | Anthropic 兼容接口地址（不含 `/v1/messages`） |
| `model` | 是 | 模型名，例如 `deepseek-flash` |
| `effort` | 是 | 思考强度；夜间整理建议 `high` |
| `budget` | 是 | 每晚自限（元），超了就停在当前段，第二天接着做 |
| `window` | 是 | `{ "start": "HH:MM", "end": "HH:MM" }`，只在这个时段里运行（北京时间；选对话最少的深夜时段） |
| `prices` | 否 | `{ "miss": 1.0, "hit": 0.02, "out": 4.0 }`，每百万 token 的元；用于估算花费 |
| `maxChars` / `maxSteps` | 否 | 每段材料最多多少字 / 每段最多几步 |
| `style` | 否 | `{ "detail": true, "privacy": true, "changes": true }`：开关 A / B / I |
| `followUp` | 否 | `{ "loose": true, "keys": true, "weight": true }`：开关 F / K / W（`mid` 为开关 M） |
| `lean` | 否 | 开关 N：夜间封顶 |
| `synonyms` | 否 | 开关 S：同义键 |
| `slots` | 否 | 开关 Y：有效期 + 键 |
| `card` | 否 | 开关 T：人物卡 |

模型 key 从环境变量 `DEEPSEEK_API_KEY` 读，不写进配置文件，也不会被打印。

### 4.3 运行

```bash
node --no-warnings night-review.mjs /etc/companion-night/config.json              # 正式运行（不在时段里就直接退出）
node --no-warnings night-review.mjs /etc/companion-night/config.json --rehearse /tmp/night-rehearsal   # 演练
```

- **演练**（`--rehearse <空目录>`）：在给定目录里造一个虚构的一天和临时生命目录，经真实接口跑一遍，只打印数字和记下条目的分类，跑完删掉目录，不碰她的任何东西。上线前先演练一次。
- **定时**：用 cron 或 systemd timer 每晚在时段内触发一次。必须以和 DSH **相同的系统用户**运行（`memory.db` 是 0600）；如果 DSH 跑在沙箱里（只读系统、受限的可写路径），夜间整理最好用同一套沙箱设置。
- **输出**：只打印 `[night-review]` 开头的数字、状态和原因，不打印对话、她写的内容或系统提示。退出码：0 做完或今天没有新对话；1 出错；3 没做完（预算或步数用完，下次接着做）；64 用法不对。
- 当前日期与时段按北京时间（UTC+8）计算。

## 5. 升级到 0.7 与迁移

新版插件第一次打开记忆库时会自动加列、建表（不升表结构版本），所以不跑迁移也能用。迁移脚本额外做三件事：在线备份、给已有条目回填键、完整性检查。

```bash
npx tsc -b
npx esbuild deploy/migrate/0.7.mjs --bundle --platform=node --format=esm --target=node22 --outfile=out/migrate-0.7.mjs
```

在服务器上（以 DSH 的系统用户、最好先停 DSH）：

```bash
node --no-warnings migrate-0.7.mjs /home/companion/life/memory.db --dry-run   # 只读：数一数会标多少条
node --no-warnings migrate-0.7.mjs /home/companion/life/memory.db             # 备份 → 加列建表 → 回填键 → 完整性检查
```

- 备份写在同目录，名为 `memory.db.pre-0.7-<北京时间>`，备份后核对条数与 `integrity_check`。
- 回填只**打标**（`slot_by = 'system'`），不让任何旧条失效、不写有效期；别人的事不标。
- 只打印条数、键名和备份文件名，不打印任何一条的内容。
- 退出码：0 做完；1 出错（库没动，或已回滚）；2 用法不对；3 做完了但完整性检查不一致——备份在，先别启动。

## 6. 危机协议（开关 Z）

`crisis: true` 打开后，每条真人消息先过词法分级，谨慎期里每轮给她注意事项，高等级时由代码直接通知紧急联系人（见 [`architecture.md` 第 7 节](architecture.md#7-危机协议开关-z)）。

- 通知通道：插件附带的实现调用宿主里一个能发私信的工具（默认 `qq_bridge_send`），目标是 `emergencyContact`。启动日志里会写“通知通道 可用 / 不可用（原因）”。
- 换别的通道（邮件、Webhook、IM 机器人）：引擎侧的 `CrisisWatch.observe()` 只返回 `notify: { level, text }`，怎么送达由宿主决定；在 `packages/dsh-plugin/src/crisis-notify.ts` 换一个实现即可。
- `emergencyContact` 只写在私有预设里；代码和日志里不出现号码。
- 默认资源是中国大陆的 12356 / 110 / 120，其他地区请修改 `packages/memory/src/crisis.ts` 里的资源行。
- 上线前在一个影子会话里演练：发三句不同等级的话，核对她的回复给了资源、没给方法、没说教；紧急联系人收到通知；谨慎期按时解除。

## 7. 升级前备份与回滚

**升级前**：

1. 备份记忆库：停 DSH 后复制 `memory.db`，或用 SQLite 在线备份；0.7 迁移脚本会自动做一份。新版插件会升级检索索引（例如 0.6 起加同义键列并重建全文索引），回滚时索引不会自动退回，所以单独留一份备份很重要。
2. 备份插件目录（profile 下的 `node_modules/dsh-her-life`）和预设。
3. 记下当前版本号与开关组合。

**回滚**：

1. 把插件目录换回旧版本，重启 DSH。新加的列和表旧代码不认识也不碍事，同一个库照常打开。
2. 如果需要连数据一起回退，停 DSH，用备份的 `memory.db` 替换。
3. 用 `MemoryStore.verifyIntegrity()`（或迁移脚本的完整性检查）确认正文哈希逐条一致。

## 8. 安全建议

这些是通用原则，具体做法按你的环境定。

- **真 key 不进 agent 进程。** 在本机跑一个小的密钥网关（反向代理）：真正的模型 key 只在网关里，DSH 和夜间整理只拿一个本地令牌；网关负责每日额度、速率限制和模型白名单，失控时自动熔断。
- **出网白名单。** 运行 DSH 的系统用户只能访问它需要的地址（网关、消息平台），默认拒绝其他出网。将来让她上网之前，这一条尤其要先做好。
- **最小权限。** 专用系统用户；种子 root 所有、她只读；生命目录 0700、`memory.db` 0600；系统目录只读。用 `blockTools` 屏蔽这个会话不该碰的宿主工具（插件还有执行前拦截兜底）。
- **管理走管理通道，不走聊天。** 改配置、白名单、额度只在服务器上由管理员做；聊天里任何人（包括主人）都不能让她改这些。
- **记忆库备份加密。** 每晚把生命目录（`memory.db` 用 SQLite 在线备份，加上日记与 self.md）加密后存到服务器之外，并定期演练恢复。
- **诊断不带机密。** 部署和诊断脚本只打印是 / 否、数字和状态；不要打印令牌、联系方式、对话正文。提交前跑 `npm run scan`。
