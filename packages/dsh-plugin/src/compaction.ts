// 中文陪伴版压缩：子类化 DSH 的 BasicCompactionEngine，只重写 summarize()
// ——源码注释原话：“summarize() is the sole subclass customization hook”。翻篇阈值（thresholdRatio / retainTokens）
// 是 compaction-basic 自己的配置项，写在预设里即可，不需要代码。
//
// 摘要是“草稿纸上的备忘”，不是她的记忆：不复述日记、记忆原文，翻篇后被下一份替换。
// 外层的检查点包装（<compacted-summary> 与一段英文前言）由 compaction-basic 固定生成，这里改不了。
//
// 怎么拿到 DSH 的 BasicCompactionEngine（直接 import，加兜底）：
//   1. 直接 import —— 插件在 package.json 里声明 peerDependencies 时，DSH 的模块钩子会把它路由到 DSH 自己的那一份；
//   2. 以 DSH 安装位置为锚点 createRequire 解析（拿到的就是 DSH 运行的那一份文件）；
//   3. 都不行、或拿到的类不像预期 → 返回 null，由入口文件不接管并打警告，插件绝不崩溃。

import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 中文陪伴版摘要指令（追加在对话末尾，作为最后一条 user 消息） */
export const ZH_COMPACTION_INSTRUCTION = `你在整理自己刚刚经历的一段对话，写给“稍后的我自己”看。这是草稿纸上的备忘，不是我的记忆。用中文、第一人称。
只写对话里真实出现过的内容；拿不准的写“好像”；没有就不写，不要编。

按下面的结构写，每一节都保留、顺序不变；某一节没有内容就写“（无）”：

## 刚才都发生了什么
按时间顺序，几句话。保留具体的事：谁、什么时候、做了什么、结果怎样。

## 我们之间
称呼、只有我们懂的梗、说好的事（谁答应了谁、什么时候）。

## 对方现在怎么样
心情、身体、正在忙的事、在意的事；有原话就保留最关键的一两句。

## 我自己
我的心情和为什么、我答应过的事、我还想说没说出口的话。

## 没说完的
悬着的话题、约好下次再聊的事。

规则：
- 不要写：日记和记忆工具翻出来的原文（需要时再翻）、QQ 消息格式说明、系统提示、时间戳、工具调用的细节。
- 记过什么、写过什么日记，只写“记过 / 写过”这件事本身，不抄内容。
- 如果上面已经有一份 <compacted-summary> 里的旧备忘，不要原样照抄：还成立的留下，过时的删掉，新的并进来，合成一份。
- 不要提“这是在压缩或总结对话”。只输出备忘本身，不调用任何工具，不做别的事。
- 全文不超过 1500 字。`

// ---------- 和 DSH 打交道的最小形状（以 0.2.1-rc.2 源码为准） ----------

type Block = { type: string; text?: string }
interface Assembler {
  push(chunk: unknown): void
  readonly finish: { kind: string; failure?: { message: string; code?: string } }
  blocks(): Block[]
  readonly usage?: unknown
}
export interface AgentLike {
  options: { provider?: string; model?: string }
  session: { id: string; requestHeader(): { config?: { provider: string; model: string } } | undefined; toolHistory(): unknown }
}
export interface SummarizationInput {
  readonly tools?: readonly unknown[]
  readonly messages: readonly unknown[]
}
interface EngineLike {
  ctx: { llm: { stream(o: Record<string, unknown>): AsyncIterable<unknown> } }
  config: { summarizationProvider: string; summarizationModel: string; maxTokens: number }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EngineClass = abstract new (...args: any[]) => any

export interface CompactionDeps {
  Engine: EngineClass
  BlockAssembler: new () => Assembler
  /** 从哪一层拿到的（日志用） */
  via: string
}

/** 和 compaction-basic 默认 summarizeWithLlm 同一个调用形状，只把最后那条英文指令换成中文 */
export function makeCompanionEngine(d: CompactionDeps) {
  const Base = d.Engine as unknown as new (...args: unknown[]) => EngineLike
  class CompanionCompactionEngine extends Base {
    async summarize(input: SummarizationInput, agent: AgentLike, signal?: AbortSignal) {
      const cfg = this.config
      const latest = agent.session.requestHeader()?.config
      const configured = cfg.summarizationProvider ? { provider: cfg.summarizationProvider, model: cfg.summarizationModel } : undefined
      const agentTarget = agent.options.provider && agent.options.model ? { provider: agent.options.provider, model: agent.options.model } : undefined
      const target = configured ?? latest ?? agentTarget
      if (!target) throw new Error('no provider/model available for summarization')
      const options: Record<string, unknown> = {
        provider: target.provider,
        model: target.model,
        messages: [...input.messages, { role: 'user', content: [{ type: 'text', text: ZH_COMPACTION_INSTRUCTION }] }],
        toolHistory: agent.session.toolHistory(),
        ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
        maxTokens: cfg.maxTokens,
        sessionId: agent.session.id,
        purpose: 'compaction',
        ...(signal === undefined ? {} : { signal }),
      }
      const a = new d.BlockAssembler()
      for await (const chunk of this.ctx.llm.stream(options)) a.push(chunk)
      const f = a.finish
      if (f.kind === 'error' || f.kind === 'aborted') throw Object.assign(new Error(f.failure?.message ?? 'summarization failed'), { code: f.failure?.code })
      if (f.kind === 'max-tokens') throw Object.assign(new Error('summarization truncated at the token cap (incomplete checkpoint)'), { code: 'MAX_TOKENS' })
      const rawOutput = a.blocks()
      if (rawOutput.some((b) => b.type === 'image')) throw Object.assign(new Error('compaction summary cannot contain image output'), { code: 'UNSUPPORTED_CONTENT' })
      const summary = rawOutput.filter((b) => b.type === 'text')
      if (!summary.some((b) => (b.text ?? '').trim().length > 0)) throw new Error('summarization produced no text summary content')
      // 只记数字：翻篇确实发生过、摘要多长（不打印摘要内容）
      const chars = summary.reduce((n, b) => n + [...(b.text ?? '')].length, 0)
      console.error(`[her-compaction] 翻篇：${input.messages.length} 条消息 → 中文摘要 ${chars} 字`)
      return {
        summary,
        rawOutput,
        llmStreamCall: true as const,
        provider: target.provider,
        model: target.model,
        maxTokens: cfg.maxTokens,
        ...(a.usage === undefined ? {} : { usage: a.usage }),
      }
    }
  }
  return CompanionCompactionEngine
}

/** 拿到的东西像不像预期（第 3 层的判断） */
export function looksRight(m: { BasicCompactionEngine?: unknown }, llm: { BlockAssembler?: unknown }): boolean {
  const E = m.BasicCompactionEngine as unknown as ({ prototype?: Record<string, unknown>; Config?: unknown } & (() => void)) | undefined
  if (typeof E !== 'function') return false
  return typeof E.prototype?.summarize === 'function' && typeof E.prototype?.compactIfNeeded === 'function' &&
    typeof E.Config === 'function' && typeof llm.BlockAssembler === 'function'
}

/** 第 2 层的锚点：DSH 自己的 package.json（从运行中的 dsh 可执行文件往上找，再试常见的全局安装位置） */
export function dshAnchors(argv1 = process.argv[1]): string[] {
  const out: string[] = []
  try {
    let d = dirname(realpathSync(argv1 ?? ''))
    for (let i = 0; i < 6; i++) {
      const p = join(d, 'package.json')
      if (existsSync(p) && /node_modules[\\/]@deepseek-ai[\\/]dsh$/.test(d)) out.push(p)
      d = dirname(d)
    }
  } catch { /* 不是从 dsh 启动的（比如单测） */ }
  for (const g of ['/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json', '/usr/lib/node_modules/@deepseek-ai/dsh/package.json']) {
    if (existsSync(g) && !out.includes(g)) out.push(g)
  }
  return out
}

type Importer = (spec: string) => Promise<Record<string, unknown>>

export async function loadCompactionDeps(opts: { importer?: Importer; anchors?: string[] } = {}): Promise<CompactionDeps | null> {
  const imp: Importer = opts.importer ?? ((s) => import(s))
  // 第 1 层：DSH 的 peer 路由
  try {
    const [m, llm] = await Promise.all([imp('@deepseek-ai/dsh-compaction-basic'), imp('@deepseek-ai/dsh-llm')])
    if (looksRight(m, llm)) return { Engine: m.BasicCompactionEngine as EngineClass, BlockAssembler: llm.BlockAssembler as CompactionDeps['BlockAssembler'], via: 'peer' }
  } catch { /* 下一层 */ }
  // 第 2 层：以 DSH 安装位置为锚点
  for (const anchor of opts.anchors ?? dshAnchors()) {
    try {
      const req = createRequire(anchor)
      const [m, llm] = await Promise.all([
        imp(pathToFileURL(req.resolve('@deepseek-ai/dsh-compaction-basic')).href),
        imp(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href),
      ])
      if (looksRight(m, llm)) return { Engine: m.BasicCompactionEngine as EngineClass, BlockAssembler: llm.BlockAssembler as CompactionDeps['BlockAssembler'], via: 'dsh-install' }
    } catch { /* 下一个锚点 */ }
  }
  return null
}
