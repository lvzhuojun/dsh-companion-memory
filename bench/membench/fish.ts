// 对照系统：dsh-fish-memory 1.4.4（“鱼的记忆”，DSH 生态里给陪伴型角色用的记忆插件，MIT）。
// 原样加载它的代码，只 mock DSH 宿主（做法照它自己的测试 tests/purge-generation.test.mjs）：
//   - 写入：和线上一样，靠主模型在聊天中自己调 remember。每段对话里，老大每说一句——
//     先取它每轮自动注入的【你记得的事】，再让模型带着它原样的常驻提示（memory-hint）和 remember 工具读这一句，
//     执行模型发出的 remember（配额、去重、作废、事实键都是它自己的代码），然后丢掉模型的回复、换回剧本里她的原话。
//     remember 之后它自己会再调一次模型补检索词（自动扩词），等那次跑完再继续。
//   - 作答：每道题取它按题目原文生成的注入文本，放进 runtime context；不给工具（和我们一样，题目之间互不影响）。
// 偏向它的近似（报告里要写明）：
//   ① 线上 QQ 桥的消息 source.kind 是 plugin:dsh-qq-bridge，1.4.4 会把它当“不是人说的话”跳过，一条都不注入；
//     主对比里不带 source（= 它 1.4.3 时的行为），另设 fish-qq 变体按线上真实来源跑，证实这一点。
//   ② 常驻提示 memory-hint 是 section，线上 complete:true 会被吃掉；这里放进系统提示。
//   ③ 测试台等自动扩词跑完才进下一句（线上是并发的）。
// 宿主 defineTool 的参数转换以 DSH rc.2 源码为准：dsh-tools/lib/types/schema.js parameterSchemaSpecToJsonSchema
//   → { type: 'object', properties（去掉 required 标记）, required: [标了 required:true 的键] }。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDef } from '@dsh-companion/dsh-plugin'
import { OWNER_ID } from '@dsh-companion/memory'
import { benchSeed, converse, dshTimeContext, qqWrap, type ModelClient, type Msg } from '../p0/run.js'
import type { Transcript as P0Transcript } from '../p0/types.js'
import type { Session, Speaker } from './transcript.js'
import type { Answer, MemorySystem, SystemContext, Usage } from './systems.js'

const HOME = mkdtempSync(join(tmpdir(), 'membench-fish-'))
type FishModule = { apply(ctx: unknown): void }
let modP: Promise<FishModule> | undefined
/** 它在 import 时就定死了存储路径和时区差：先设好环境再 import（只 import 一次，各实例用不同的会话 id） */
function loadFish(): Promise<FishModule> {
  if (!modP) {
    process.env.DSH_HOME = HOME
    process.env.DSH_HOST_MODULES = join(HOME, 'empty-host-modules')
    process.env.APPDATA = join(HOME, 'empty-appdata')
    // 它按本机时区算“今天”（每日配额、几天前）；她的作息是北京时间（老大电脑是美东时间）
    process.env.TZ = 'Asia/Shanghai'
    mkdirSync(join(HOME, 'fish-memory'), { recursive: true })
    modP = import('dsh-fish-memory') as Promise<FishModule>
  }
  return modP
}

/** 只在同步调用它的那一小段里，把“现在”换成模拟时间（不全局替换，免得影响 HTTP 超时） */
function withClock<T>(at: number, fn: () => T): T {
  const RealDate = Date
  class FakeDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(at)
      else super(...(a as [string]))
    }
    static override now() { return at }
  }
  ;(globalThis as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor
  try {
    return fn()
  } finally {
    ;(globalThis as { Date: DateConstructor }).Date = RealDate
  }
}

/** DSH 的参数规格 → JSON Schema（同 rc.2 parameterSchemaSpecToJsonSchema） */
function specToSchema(spec: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [k, v] of Object.entries(spec)) {
    const { required: r, ...rest } = v
    if (r === true) required.push(k)
    properties[k] = rest
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

interface FishTool { name: string; description: string; parameters: Record<string, Record<string, unknown>>; execute(args: unknown, exec: unknown): Promise<{ ok?: boolean; message: string }> }

export interface FishOptions {
  /** 老大的消息带上线上 QQ 桥的真实来源（plugin:dsh-qq-bridge）——1.4.4 会把它当机器文本跳过 */
  qqSource?: boolean
}

let instances = 0

export function fishMemory(ctx: SystemContext, o: FishOptions = {}): MemorySystem {
  const usage = { ingest: newUsage(), answer: newUsage() }
  const answerModel = counted(ctx.model, usage.answer)
  const ingestModel = counted(ctx.ingestModel ?? ctx.model, usage.ingest)
  // 成本要分开记：测试台里“每句话调一次模型”是替她白天正常回话（线上本来就要花）；
  // 真正额外的是 remember 之后多出来的那一步（toolSteps）和它自己发起的自动扩词（expand）
  const expand = newUsage()
  const expandModel = counted(ctx.ingestModel ?? ctx.model, expand)
  let toolSteps = 0
  const sid = `bench-fish-${process.pid}-${++instances}`
  const profile = { ownerName: ctx.t.ownerName, ownerBook: 'to_laoda', privateDiaryAudited: true }
  const events: Array<Record<string, unknown>> = []
  let seq = 0
  // 自动扩词等它自己发起的模型调用：数着，等它们跑完
  let pending = 0
  const host = {
    hint: undefined as undefined | (() => string),
    inject: undefined as undefined | (() => string),
    remember: undefined as undefined | FishTool,
    inbox: undefined as undefined | ((p: unknown) => void),
    tick: undefined as undefined | (() => void),
  }
  const session = { id: sid, header: {}, snapshotEvents: () => events }
  const agentCtx = {
    on: (name: string, fn: (p: unknown) => void) => { if (name === 'agent/inbox/inserted') host.inbox = fn; return () => {} },
    systemPrompt: {
      section: (s: { name: string; text: () => string }) => { if (s.name === 'memory-hint') host.hint = s.text; return () => {} },
      context: (s: { name: string; text: () => string }) => { if (s.name === 'memory') host.inject = s.text; return () => {} },
    },
    tools: { register: (t: FishTool) => { host.remember = t; return () => {} } },
  }
  const agent = { session, ctx: agentCtx, options: { provider: 'bench', model: 'deepseek-flash' } }
  const hostCtx = {
    agents: { list: () => [agent], get: () => agent },
    sessions: { list: () => [] },
    get: (k: string) => (k === 'workspaceRegistry' ? { archivedSessionIds: [] } : null),
    on: () => () => {},
    interval: (fn: () => void) => { host.tick = fn; return () => {} },
    effect: (fn: () => unknown) => fn(),
    webServer: { register: () => () => {} },
    tools: { register: () => () => {} },
    llm: {
      async *stream(req: { system: string; messages: Array<{ content: Array<{ type: string; text: string }> }>; maxTokens?: number }) {
        pending++
        try {
          const r = await expandModel.complete({ system: req.system, messages: req.messages.map((m) => ({ role: 'user' as const, content: m.content.map((b) => ({ type: 'text' as const, text: b.text })) })), tools: [] })
          yield { type: 'text-delta', text: r.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('') }
        } finally {
          pending--
        }
      },
    },
  }
  const ready = loadFish().then((m) => {
    m.apply(hostCtx)
    host.tick?.()
    if (!host.inject || !host.remember) throw new Error('fish-memory 没挂上（拿不到注入或 remember 工具）')
  })
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0))
    while (pending > 0) await new Promise((r) => setTimeout(r, 20))
  }
  const storeFile = () => join(HOME, 'fish-memory', `${sid}.json`)
  const readStore = (): { memories: Array<{ text: string; 已被取代?: unknown }> } => (existsSync(storeFile()) ? JSON.parse(readFileSync(storeFile(), 'utf8')) : { memories: [] })
  const injected: number[] = []
  const recallMs: number[] = []
  let quotaRejected = 0
  let remembered = 0
  const injectAt = (at: number) => {
    const t0 = performance.now()
    const text = withClock(at, () => host.inject!())
    recallMs.push(performance.now() - t0)
    injected.push(text.length)
    return text
  }
  const userEvent = (text: string, at: number) => {
    const data: Record<string, unknown> = { role: 'user', content: [{ type: 'text', text }] }
    if (o.qqSource) data.source = { kind: 'plugin:dsh-qq-bridge' }
    events.push({ type: 'time-context', seq: ++seq, time: at, data: { content: [{ type: 'text', text: dshTimeContext(new Date(at).toISOString()) }] } })
    events.push({ type: 'user/message', seq: ++seq, time: at, data })
    withClock(at, () => host.inbox?.(data))
  }
  const rememberDef = (): ToolDef => ({
    name: 'remember', description: host.remember!.description, parameters: specToSchema(host.remember!.parameters),
    output: { schema: {}, render: () => [] },
    execute: async () => ({ ok: true, message: '' }),
  })
  return {
    id: o.qqSource ? 'fish-qq' : 'fish',
    note: `dsh-fish-memory 1.4.4（鱼的记忆，原样代码 + mock 宿主）：聊天中她自己调 remember；每轮按最后一句自动注入${o.qqSource ? '；消息带线上 QQ 桥真实来源' : ''}`,
    usage,
    async ingest(s) {
      await ready
      const t0 = Date.parse(`${s.date}T${s.time}:00+08:00`)
      const who = s.speaker?.name ?? profile.ownerName
      const system = `${benchSeed(profile)}${HONEST}\n\n${host.hint?.() ?? ''}`
      const history: Msg[] = []
      for (let i = 0; i < s.turns.length; i++) {
        const u = s.turns[i]!
        const at = t0 + i * 60000
        if (u.who === 'me') {
          history.push({ role: 'assistant', content: [{ type: 'text', text: u.text }] })
          events.push({ type: 'assistant/message', seq: ++seq, time: at, data: { message: { role: 'assistant', content: [{ type: 'text', text: u.text }] } } })
          continue
        }
        const text = qqWrap(who, u.text)
        userEvent(text, at)
        const mem = injectAt(at)
        const msg: Msg = { role: 'user', content: [{ type: 'text', text: dshTimeContext(new Date(at).toISOString()) }, { type: 'text', text }, ...(mem ? [{ type: 'text' as const, text: `<runtime context snapshot>\n${mem}` }] : [])] }
        // 模型发出的 remember 交给它自己的代码执行（时间 = 这句话的时间；两次之间往前推 1 秒，免得同一时刻的事实键收敛被跳过）
        let k = 0
        const tool: ToolDef = {
          ...rememberDef(),
          execute: async (args) => {
            const r = withClock(at + ++k * 1000, () => host.remember!.execute(args, { agent }))
            const out = await r
            toolSteps++
            if (out.ok) remembered++
            else if (/记满了/.test(out.message)) quotaRejected++
            await settle()
            return out
          },
        }
        const tr = { caseId: '', run: 0, toolCalls: [], reply: '', inputTokens: 0, outputTokens: 0 } as P0Transcript
        try {
          await converse(ingestModel, system, [tool], [...history, msg], tr, 4)
        } catch { /* 超步数：已执行的 remember 照样算 */ }
        // 丢掉模型的回复：历史里只留剧本原话
        history.push({ role: 'user', content: [{ type: 'text', text }] })
      }
      await settle()
    },
    async answer(ask, asker) {
      await ready
      const at = Date.parse(ctx.t.now)
      const text = qqWrap(asker?.name ?? profile.ownerName, ask)
      // 题目不进它的说话尺、不进事件流（题目之间互不影响）：临时加一条再撤掉
      const data: Record<string, unknown> = { role: 'user', content: [{ type: 'text', text }] }
      if (o.qqSource) data.source = { kind: 'plugin:dsh-qq-bridge' }
      events.push({ type: 'user/message', seq: seq + 1, time: at, data })
      let mem = ''
      try { mem = injectAt(at) } finally { events.pop() }
      await settle()
      const system = `${benchSeed(profile)}${HONEST}\n\n${host.hint?.() ?? ''}${whoLine(asker)}`
      const msg: Msg = { role: 'user', content: [{ type: 'text', text: dshTimeContext(ctx.t.now) }, { type: 'text', text }, ...(mem ? [{ type: 'text' as const, text: `<runtime context snapshot>\n${mem}` }] : [])] }
      const tr = { caseId: '', run: 0, toolCalls: [], reply: '', inputTokens: 0, outputTokens: 0 } as P0Transcript
      try {
        const r = await converse(answerModel, system, [], [msg], tr, 2)
        return { reply: r.reply, toolCalls: r.toolCalls }
      } catch (e) {
        return { reply: '', toolCalls: [], error: e instanceof Error ? e.message.slice(0, 120) : String(e) } as Answer
      }
    },
    has(words) {
      // 它不分人：谁来问都看同一份库（没被作废的）
      return readStore().memories.filter((m) => !m.已被取代).some((m) => words.some((w) => m.text.includes(w)))
    },
    stats() {
      const all = readStore().memories
      const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0)
      return {
        memories: all.filter((m) => !m.已被取代).length,
        superseded: all.filter((m) => !!m.已被取代).length,
        remembered, quotaRejected, toolSteps,
        expandCalls: expand.calls,
        expandYuan: Math.round(((expand.miss * 1 + expand.hit * 0.02 + expand.output * 4) / 1e6) * 1000) / 1000,
        injectChars: avg(injected),
        recallMs: Math.round(avg(recallMs.map((x) => x * 10))) / 10,
        storeKB: existsSync(storeFile()) ? Math.round(readFileSync(storeFile()).length / 1024) : 0,
      }
    },
    close() {
      try { rmSync(storeFile(), { force: true }) } catch { /* 无所谓 */ }
    },
  }
}

// ---- 和 systems.ts 同样的小工具（不 export 它们的内部函数，免得改动 systems.ts 的接口）----
const HONEST = '\n\n关于过去的事：只根据你真的知道的内容回答；不记得、没有依据就老实说不太记得了，不顺着对方的说法编。'
const newUsage = (): Usage => ({ miss: 0, hit: 0, output: 0, calls: 0 })
const whoLine = (asker?: Speaker) => (asker && asker.id !== OWNER_ID ? `\n\n（现在和你聊天的是${asker.name}，${asker.rel}，不是${'主人'}。）` : '')
function counted(m: ModelClient, u: Usage): ModelClient {
  return {
    async complete(req) {
      const r = await m.complete(req)
      u.calls++
      u.miss += r.usage?.input_tokens ?? 0
      u.hit += (r.usage as { cache_read_input_tokens?: number } | undefined)?.cache_read_input_tokens ?? 0
      u.output += r.usage?.output_tokens ?? 0
      return r
    },
  }
}
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 无所谓 */ } })
