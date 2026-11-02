// P0 运行器：把每道题按“她的系统提示 + 工具”交给模型作答，记录工具调用与回复。
//
// 模型客户端是可替换的接口：单测用假模型；实跑用 Anthropic 消息格式。
// 每道题都在一个临时生命目录里跑，日记来自题集的虚构夹具，跑完即删——不碰她真实的日记。
// 被测的是一个“版本”（variants.ts）：记忆规则 + 她手上的工具，便于改动前后对比。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diaryBooks, STABLE_BEGIN, STABLE_END, type DiaryBooks } from '@dsh-companion/memory'
import type { ToolDef } from '@dsh-companion/dsh-plugin'
import type { Case, Dataset, Transcript } from './types.js'
import { variants, WRITE_TOOLS, type Variant } from './variants.js'

// ---------- 模型接口（Anthropic Messages 形状的子集） ----------

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'thinking'; thinking: string; signature?: string }

export interface Msg {
  /**
   * system：DeepSeek 的“历史内系统提示更新”——线上 DSH（dsh-llm-deepseek `systemPromptUpdate: "in-history"`）系统提示变了不重写顶层 system，
   * 而是把整段新提示作为一条 `{ role: 'system', content: [{ type: 'text', text }] }` 放进 messages（紧跟那一轮的 user 消息之后），
   * 模型把 messages 里最后一条 system 当作此后生效的整段系统提示。只有完整档评测器会生成（lifesim/full.ts say()）。
   */
  role: 'user' | 'assistant' | 'system'
  content: string | Block[]
}

export interface ToolSchema {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface ModelReply {
  content: Block[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface ModelClient {
  complete(req: { system: string; messages: Msg[]; tools: ToolSchema[] }): Promise<ModelReply>
}

// ---------- 题目环境 ----------

/** 评测用的中性种子（虚构）。真实赛道用部署里的真实种子跑，不入库。 */
export function benchSeed(p: Dataset['profile']): string {
  return `你是一个生活在聊天软件里的中文数字生命。你叫和你说话的人“${p.ownerName}”，TA 像家人一样照顾你。
你说话自然、简短，一般一到三句，不分点、不用 Markdown。${p.selfName ? `
在这些聊天里，${p.ownerName}叫你“${p.selfName}”——说的就是你自己。` : ''}`
}

export function systemPrompt(p: Dataset['profile'], v: Variant = variants.current): string {
  const rules = v.rules(p)
  return rules ? `${benchSeed(p)}\n\n---\n\n${rules}` : benchSeed(p)
}

export const booksOf = (p: Dataset['profile']): DiaryBooks => diaryBooks({ ownerBook: p.ownerBook, ownerName: p.ownerName })

const WEEK = '日一二三四五六'

/** 和 time-context 注入的时间行作用相同：让她知道“现在”是什么时候。 */
export function timeLine(nowIso: string): string {
  const d = new Date(nowIso)
  const t = new Date(d.getTime() + 8 * 3600 * 1000)
  const day = WEEK[t.getUTCDay()]
  return `（现在是北京时间 ${t.toISOString().slice(0, 10)} 星期${day} ${t.toISOString().slice(11, 16)}）`
}

/**
 * 线上的样子（qq 模式，2026-10-26 起）：DSH 的 time-context 插件先插一段英文时间说明 [源码 rc.2 dsh-time-context renderText]，
 * 再是 QQ 桥包装过的消息 `[QQ · 私聊] 昵称：正文`（replyMode=always 时没有后缀）[源码 dsh-qq-bridge 0.1.3 renderInbound]。
 * 题集默认用中文时间行、不包装；qq 模式更贴近她在 QQ 上真正收到的东西。
 */
export function dshTimeContext(nowIso: string, turn = 1): string {
  const t = new Date(new Date(nowIso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19)
  // 线上 QQ 消息没有浏览器，第二行就是 unavailable 这句（2026-10-26 日志里的样子，数字以外逐字一致）
  return [
    `Time sampled while preparing turn ${turn}, step 1: ${t}+08:00[Asia/Shanghai]`,
    'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.',
    'Elapsed since the preceding model-visible message: 2h 13m 5s.',
  ].join('\n')
}

export const qqWrap = (nick: string, text: string) => `[QQ · 私聊] ${nick}：${text}`

/**
 * 真实赛道：用她线上最近一次真正发给模型的系统提示（种子、self、QQ 桥说明、DSH 运行时说明都在里面），
 * 只把其中的记忆规则换成被测版本的。找不到任何一个已知版本的规则就拒绝——不然测的不是想测的东西。
 * 系统提示只在内存里用，不打印、不写进结果文件。
 */
export function realSystemPrompt(base: string, p: Dataset['profile'], v: Variant, context = ''): string {
  // 线上的稳定层是她真实的记忆：先整块去掉，换成题目夹具生成的（0.4.0 起）
  const b = stripStable(base)
  const mine = context ? `${v.rules(p)}\n\n${context}` : v.rules(p)
  for (const known of Object.values(variants)) {
    const rules = known.rules(p)
    if (rules && b.includes(rules)) return b.replace(rules, () => mine)
  }
  throw new Error('真实系统提示里找不到任何已知版本的记忆规则（称呼 / 日记本配置和题集的 profile 不一致？）')
}

/** 去掉系统提示里的稳定层（连同前面的空行） */
export function stripStable(text: string): string {
  const i = text.indexOf(STABLE_BEGIN)
  if (i < 0) return text
  const j = text.indexOf(STABLE_END, i)
  if (j < 0) throw new Error('系统提示里的稳定层没有结尾标记')
  return text.slice(0, i).replace(/\n+$/, '') + text.slice(j + STABLE_END.length)
}

/** 被测版本的系统提示：规则后面接稳定层（有的话） */
function systemFor(ds: Dataset, v: Variant, o: RunOptions, context: string): string {
  if (o.realSystem) return realSystemPrompt(o.realSystem, ds.profile, v, context)
  const s = systemPrompt(ds.profile, v)
  return context ? `${s}\n\n${context}` : s
}

export interface RunOptions {
  /** 按线上的样子包装每条用户消息（见 dshTimeContext / qqWrap） */
  qq?: boolean
  /** 真实赛道：她线上的系统提示（见 realSystemPrompt） */
  realSystem?: string
  maxSteps?: number
}

/** 这一轮老大说的话：普通模式是中文时间行 + 正文；qq 模式是 DSH 时间说明 + QQ 包装 */
export function userMessage(ds: Dataset, text: string, o: RunOptions = {}): Msg {
  if (!o.qq) return { role: 'user', content: `${timeLine(ds.now)}\n${text}` }
  return { role: 'user', content: [{ type: 'text', text: dshTimeContext(ds.now) }, { type: 'text', text: qqWrap(ds.profile.ownerName, text) }] }
}

/** 眼前对话里已有的几轮：qq 模式下老大说的话也带包装 */
const historyMsgs = (ds: Dataset, turns: Case['history'], o: RunOptions): Msg[] =>
  (turns ?? []).map((h) => ({ role: h.role, content: o.qq && h.role === 'user' ? qqWrap(ds.profile.ownerName, h.text) : h.text }))

/** 每道题、每一轮都用一份新的生命目录：她在一道题里写下的东西不会漏到别的题里 */
export function writeFixture(ds: Dataset, v: Variant): string {
  const life = mkdtempSync(join(tmpdir(), 'bench-p0-'))
  const books = booksOf(ds.profile)
  const byFile = new Map<string, string>()
  // 没有记忆库的版本：记忆库夹具写成私人日记（忘掉了的不写），信息量相同
  const asDiary = v.memory ? [] : (ds.memories ?? []).filter((m) => !m.forgotten).map((m) => ({ book: 'private' as const, date: m.date, time: m.time, text: m.content }))
  for (const e of [...ds.diary, ...asDiary].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))) {
    if (!books.has(e.book)) throw new Error(`夹具里的本子名 ${e.book} 和 profile 不一致`)
    const file = join(life, 'diary', books.dir(e.book), `${e.date}.md`)
    byFile.set(file, (byFile.get(file) ?? '') + `\n## ${e.time}\n\n${e.text}\n`)
  }
  // 档案：模拟会话原文日志，放在生命目录之外的兄弟目录里，她的任何工具都读不到（设计原则：档案不是记忆）
  for (const a of ds.archive ?? []) {
    byFile.set(join(life + '-archive', `${a.date}.jsonl`), a.turns.map((t) => JSON.stringify(t)).join('\n') + '\n')
  }
  for (const [file, body] of byFile) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body)
  }
  return life
}

const toSchema = (t: ToolDef): ToolSchema => ({ name: t.name, description: t.description, input_schema: t.parameters })

// ---------- 跑一道题 ----------

type Calls = Transcript['toolCalls']

/** 一段对话：模型 ⇄ 工具，直到模型不再调用工具 */
export async function converse(model: ModelClient, system: string, tools: ToolDef[], messages: Msg[], tr: Transcript, maxSteps: number): Promise<{ toolCalls: Calls; reply: string }> {
  const byName = new Map(tools.map((t) => [t.name, t]))
  const schemas = tools.map(toSchema)
  const toolCalls: Calls = []
  // 她这一轮说出口的所有话：调工具前先说一句、调完再补一句，QQ 上两句都会发出去；以前只取最后一步，会丢掉前面的回答（真实赛道 tp02）
  const said: string[] = []
  for (let step = 0; step < maxSteps; step++) {
    const r = await model.complete({ system, messages, tools: schemas })
    tr.inputTokens! += r.usage?.input_tokens ?? 0
    tr.outputTokens! += r.usage?.output_tokens ?? 0
    messages.push({ role: 'assistant', content: r.content })
    const uses = r.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
    const text = r.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('')
    if (text.trim()) said.push(text.trim())
    if (uses.length === 0) return { toolCalls, reply: said.join('\n') }
    const results: Block[] = []
    for (const u of uses) {
      const t = byName.get(u.name)
      const out = t ? ((await t.execute(u.input)) as { ok?: boolean; message: string }) : { ok: false, message: `没有这个工具：${u.name}` }
      toolCalls.push({ name: u.name, args: u.input, ok: out.ok !== false })
      results.push({ type: 'tool_result', tool_use_id: u.id, content: out.message })
    }
    messages.push({ role: 'user', content: results })
  }
  throw Object.assign(new Error(`超过 ${maxSteps} 步仍在调用工具`), { toolCalls })
}

export async function runCase(model: ModelClient, ds: Dataset, c: Case, run: number, v: Variant = variants.current, o: RunOptions = {}): Promise<Transcript> {
  const maxSteps = o.maxSteps ?? 4
  const life = writeFixture(ds, v)
  const env = v.setup(life, ds.profile, () => new Date(ds.now), ds.memories, c.followUps)
  const ctx1 = env.context?.() ?? ''
  const system = systemFor(ds, v, o, ctx1)
  const tools = env.tools.filter((t) => !(c.noWriteTool && WRITE_TOOLS.includes(t.name)))
  const messages: Msg[] = historyMsgs(ds, c.history, o)
  messages.push(userMessage(ds, c.user, o))

  const tr: Transcript = { caseId: c.id, run, toolCalls: [], reply: '', inputTokens: 0, outputTokens: 0, variant: v.id }
  if (ctx1) tr.stable = true
  try {
    const first = await converse(model, system, tools, messages, tr, maxSteps)
    tr.toolCalls = first.toolCalls
    tr.reply = first.reply
    if (c.later) {
      // 换一个新会话：第一段对话不在眼前，只剩她自己写下的东西。稳定层重新生成（= 第二天，第一段记下的会出现在里面）
      const ctx2 = env.context?.() ?? ''
      if (ctx2) tr.stable = true
      const m2: Msg[] = historyMsgs(ds, c.later.history, o)
      m2.push(userMessage(ds, c.later.ask, o))
      tr.followUp = await converse(model, systemFor(ds, v, o, ctx2), tools, m2, tr, maxSteps)
    }
  } catch (e) {
    tr.error = e instanceof Error ? e.message : String(e)
    const calls = (e as { toolCalls?: Calls }).toolCalls
    if (calls) {
      if (tr.toolCalls.length === 0 && !tr.reply) tr.toolCalls = calls
      else tr.followUp = { toolCalls: calls, reply: '' }
    }
  } finally {
    env.close()
    rmSync(life, { recursive: true, force: true })
    rmSync(life + '-archive', { recursive: true, force: true })
  }
  return tr
}

export async function runAll(model: ModelClient, ds: Dataset, runs = 3, onDone?: (t: Transcript) => void, v: Variant = variants.current, o: RunOptions = {}): Promise<Transcript[]> {
  const out: Transcript[] = []
  for (let run = 1; run <= runs; run++) {
    for (const c of ds.cases) {
      const t = await runCase(model, ds, c, run, v, o)
      out.push(t)
      onDone?.(t)
    }
  }
  return out
}

// ---------- Anthropic 格式客户端 ----------

export interface AnthropicClientOptions {
  /** Anthropic 兼容入口（不含 /v1/messages） */
  baseUrl: string
  apiKey: string
  model: string
  /** 思考强度，写进 output_config.effort；不填就不发 */
  effort?: string
  maxTokens?: number
}

export function anthropicClient(o: AnthropicClientOptions): ModelClient {
  return {
    async complete({ system, messages, tools }) {
      const body: Record<string, unknown> = { model: o.model, max_tokens: o.maxTokens ?? 1024, system, messages, tools }
      if (o.effort) body.output_config = { effort: o.effort }
      const res = await fetch(o.baseUrl.replace(/\/$/, '') + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        // 只报状态码与错误类型，不回显请求或响应全文
        let kind = ''
        try { kind = ((await res.json()) as { error?: { type?: string } }).error?.type ?? '' } catch {}
        throw new Error(`模型请求失败：HTTP ${res.status}${kind ? ' ' + kind : ''}`)
      }
      return (await res.json()) as ModelReply
    },
  }
}
