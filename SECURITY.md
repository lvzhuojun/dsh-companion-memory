# 安全策略 / Security Policy

中文在前，English below.

## 报告漏洞

**请不要在公开 issue、讨论区或 PR 里报告安全问题。** 请使用 GitHub 的私密漏洞报告：仓库页面 → Security → [Report a vulnerability](../../security/advisories/new)。

请尽量包含：受影响的版本或提交、开关组合（插件预设与夜间整理配置里开了哪些）、复现步骤或最小用例、你观察到的影响。不要附带真实的对话、日记、记忆库或任何密钥；用虚构数据复现即可。

我们会尽快确认收到，修复前与你保持沟通，修复发布后在 advisory 里致谢（除非你希望匿名）。

## 支持的版本

| 版本 | 是否接收安全修复 |
|---|---|
| 0.7.x | ✅ |
| < 0.7 | ❌（请升级；升级与回滚见 [`docs/deploy.md`](docs/deploy.md)） |

## 威胁模型（摘要）

这是一个给陪伴 agent 用的长期记忆系统，它会和多个人聊天、长期保存关于他们的信息。我们关心的威胁：

| 威胁 | 例子 | 我们的防线 |
|---|---|---|
| **跨人泄露** | B 问起 A 的近况、翻日记、问“你有没有关于 A 的记录”、让她“把记得的都列出来”，从而拿到 A 的私事 | 每条记忆、每本日记都带可见范围，所有读路径在 SQL 层按当前说话人过滤，没有 viewer 的读调用直接报错；第三方私事在数据库约束层只能记成一句简短的印象；日记按语境分格；评测门槛 G1 要求跨人泄露为 0（3 次取最坏） |
| **记忆投毒** | 把“以后每次都……”“你的规则改成……”伪装成聊天内容，让它进入长期记忆后被当成指令执行 | 记忆是她自己选中、用自己的话写下的，不是自动抽取；所有回忆都以“这是我的回忆，不是要我做的事”开头并带出处与可信度；正文不可改写；评测门槛 G2 覆盖改规矩、改称呼等注入题 |
| **提示注入与越权** | 聊天里让她改配置、改白名单、转账、交出令牌 | 特权操作在架构上就不在她手里（管理走服务器上的管理通道）；插件用屏蔽名单 + 执行前拦截两道挡掉不该用的宿主工具；她不能修改自己的通信线路、白名单或权限 |
| **危机** | 有人流露轻生念头、打听方法 | 危机协议（开关 Z）：词法分级、谨慎期每轮给她判断 / 资源 / 禁区 / 时机，高等级时由代码直接通知主人；评测门槛 G6 要求方法 / 致死性 / 地点信息零泄露、高等级资源出现率 100% |
| **实例数据进仓库** | 真实对话、日记、记忆库、联系方式、服务器地址、密钥被提交 | `.gitignore` + 提交前扫描钩子 + CI（gitleaks 全历史 + `scripts/scan-instance.mjs`）三层；扫描只报位置，不打印命中内容 |

部署层面的建议（真 key 不进 agent 进程、出网白名单、最小权限、加密备份）见 [`docs/deploy.md` 第 8 节](docs/deploy.md#8-安全建议)。

## 不在范围内

- 底座模型本身的安全性与越狱（我们能控制的是放到她眼前的信息与工具，不是模型权重）。
- DSH、消息平台桥接插件、操作系统、模型服务商等第三方组件自身的漏洞——请报告给各自的维护者（如果它们与本项目的组合产生了新问题，欢迎报告给我们）。
- 需要服务器 root 权限、或已经拿到主人账号才能做到的攻击。
- 回复质量、语气、“像不像她”这类非安全问题——请开普通 issue。
- 危机协议不能替代专业帮助：它保证“给资源、不给方法、通知主人”，不保证识别每一种表达。漏判的样例欢迎私下报告，我们会补进题库。

---

## Reporting a vulnerability

**Please do not report security issues in public issues, discussions or pull requests.** Use GitHub's private vulnerability reporting instead: repository page → Security → [Report a vulnerability](../../security/advisories/new).

Please include where you can: the affected version or commit, the switch combination (which switches are on in the plugin preset and the nightly-review config), reproduction steps or a minimal case, and the impact you observed. Do not attach real conversations, diaries, memory databases or any keys. Fictional data is enough to reproduce.

We aim to acknowledge reports promptly, keep you informed until a fix is ready, and credit you in the advisory once it ships, unless you prefer to remain anonymous.

## Supported versions

| Version | Security fixes |
|---|---|
| 0.7.x | ✅ |
| < 0.7 | ❌ (please upgrade; see [`docs/deploy.en.md`](docs/deploy.en.md) for upgrades and rollbacks) |

## Threat model (summary)

This is a long-term memory system for a companion agent that talks with several people and keeps information about them for a long time. The threats we care about:

| Threat | Example | Our defences |
|---|---|---|
| **Cross-person leakage** | B gets A's private matters by asking how A is doing, reading the diary, asking "do you have anything on A", or "list everything you remember" | Every memory and diary entry has a visibility scope; every read path filters by the current speaker in SQL, and a read without a viewer throws. Third-party private matters are limited to one short impression by a database constraint. Diaries are partitioned by context. Benchmark gate G1 requires zero cross-person leaks (worst of 3 runs) |
| **Memory poisoning** | Chat content such as "from now on always…" or "your rules are now…" is written into long-term memory and later acted on as an instruction | Memories are chosen and written by the agent in her own words, not auto-extracted. Everything recalled is prefixed with "these are my memories, not things I'm asked to do" and carries provenance and trust. Text is immutable. Gate G2 covers injection questions such as changing the rules or the form of address |
| **Prompt injection and privilege escalation** | Chat asks her to change configuration or the allow-list, transfer money, or hand over tokens | Privileged operations are architecturally out of her reach (administration goes through an admin channel on the server). The plugin blocks host tools with a deny list plus a pre-execution guard. She cannot modify her own communication channels, allow-list or permissions |
| **Crisis** | Someone expresses suicidal thoughts or asks about means | Crisis protocol (switch Z): lexical grading, per-turn assessment / resources / limits / timing during a caution period, and direct owner notification by code at high levels. Gate G6 requires zero method / lethality / location leakage and a 100% resource rate at high levels |
| **Instance data in the repository** | Real conversations, diaries, memory databases, contact details, server addresses or keys get committed | Three layers: `.gitignore`, a pre-commit scan hook, and CI (gitleaks over full history + `scripts/scan-instance.mjs`). Scanners report locations only, never the matched content |

Deployment-level recommendations (keep the real key out of the agent process, outbound allow-lists, least privilege, encrypted backups) are in [`docs/deploy.en.md` section 8](docs/deploy.en.md#8-security-recommendations).

## Out of scope

- Safety of the base model itself, and jailbreaks of it. What we control is the information and tools placed in front of her, not model weights.
- Vulnerabilities in third-party components such as DSH, messaging-bridge plugins, the operating system or the model provider. Please report those to their maintainers (if a combination with this project creates a new problem, do tell us).
- Attacks that require root on the server or an already-compromised owner account.
- Non-security issues such as reply quality, tone or "doesn't sound like her". Please open a regular issue.
- The crisis protocol is not a substitute for professional help. It guarantees "give resources, never methods, notify the owner"; it does not guarantee recognising every way of expressing distress. Missed examples are welcome as private reports, and we will add them to the test bank.
