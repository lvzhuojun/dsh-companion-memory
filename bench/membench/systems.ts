// 记忆基准的被测系统：统一接口
//   ingest(session)  一段对话结束：系统自己决定记什么
//   answer(ask, now) 回答一个问题（附带它调用了什么工具、用了多少 token）
// 所有系统共用：同一个底座模型、同一份中性人设（benchSeed）、同一种用户消息包装（QQ + DSH 时间说明）。区别只在记忆。

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { makeNoticer, memoryRules, recallChatTool, recallDiaryTool, recallMemoryTool, runNightReview, type ToolDef } from '@dsh-companion/dsh-plugin'
import { ChatHistory, CrisisWatch, diaryBooks, MemoryStore, OWNER_ID, parseSessionLog, PREFIX_TIERS, stableLayer, stableLayerWithIds, tokenize, type GateThresholds, type PrefixTier } from '@dsh-companion/memory'
import { benchSeed, converse, dshTimeContext, qqWrap, type ModelClient, type Msg } from '../p0/run.js'
import type { Dataset, Transcript as P0Transcript } from '../p0/types.js'
import { renderSessions, type Session, type Speaker, type Transcript } from './transcript.js'
import { fishMemory } from './fish.js'
import { byAnswer, byNight, Meter, metered } from '../lifesim/meter.js'

export interface Usage {
  /** 未命中缓存的输入 token */
  miss: number
  /** 命中缓存的输入 token */
  hit: number
  output: number
  calls: number
}

/** 按 flash 闲时价估算（元）：未命中 1、命中 0.02、输出 4（每百万）；实际以服务商账单为准 */
export const costOf = (u: Usage) => (u.miss * 1 + u.hit * 0.02 + u.output * 4) / 1e6

export interface Answer {
  reply: string
  toolCalls: P0Transcript['toolCalls']
  error?: string
}

export interface MemorySystem {
  id: string
  /** 说明（报告里用） */
  note: string
  ingest(s: Session): Promise<void>
  /** asker：谁来问（多人；不给 = 主人） */
  answer(ask: string, asker?: Speaker): Promise<Answer>
  /** 建记忆、回答各花了多少 */
  usage: { ingest: Usage; answer: Usage }
  close(): void
  /** 长期运行的指标（100 天模拟器每天记一次；没有就不记） */
  stats?(): Record<string, number>
  /** 诊断（100 天模拟）：这个人此刻能看到的记忆里，有没有出现过这些词（分清“没记下”还是“记下了没翻到”）；没有记忆库的系统不实现 */
  has?(words: string[], asker?: Speaker): boolean
  /** 快照 / 回放：把此刻的整个记忆（库 + 日记）存到 dir；从 dir 恢复（各设置从同一起点答题） */
  save?(dir: string): void
  load?(dir: string): void
  /** 决定记忆内容的那部分设置（写侧开关）；回放时快照的 writeKey 必须和它一致 */
  writeKey?: string
}

export interface SystemContext {
  t: Transcript
  /** 回答用的模型（flash · low，和她白天一致） */
  model: ModelClient
  /** 建记忆用的模型（需要时；我们的夜间回顾用 high） */
  ingestModel?: ModelClient
}

const profile = (t: Transcript): Dataset['profile'] => ({ ownerName: t.ownerName, ownerBook: 'to_laoda', privateDiaryAudited: true, ...(t.selfName ? { selfName: t.selfName } : {}) })
const newUsage = (): Usage => ({ miss: 0, hit: 0, output: 0, calls: 0 })

/** 没有工具的系统共用的一句诚实要求（我们的规则里本来就有更完整的版本） */
const HONEST = '\n\n关于过去的事：只根据你真的知道的内容回答；不记得、没有依据就老实说不太记得了，不顺着对方的说法编。'

/** 计数的模型包装：把用量记到某一栏 */
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

// extra：记忆 v2 开关 J / K 追加的“想起来的 / 该问问了”（线上是 pre-step 追加在真人消息后面的一条 user 消息，这里放进同一条消息的下一块）
const userMsg = (t: Transcript, ask: string, asker?: Speaker, extra?: string): Msg => ({ role: 'user', content: [{ type: 'text', text: dshTimeContext(t.now) }, { type: 'text', text: qqWrap(asker?.name ?? t.ownerName, ask) }, ...(extra ? [{ type: 'text' as const, text: extra }] : [])] })

/** 不是主人来问时，告诉她现在是谁（人设里默认是主人） */
const whoLine = (asker?: Speaker) => (asker && asker.id !== OWNER_ID ? `\n\n（现在和你聊天的是${asker.name}，${asker.rel}，不是${'主人'}。）` : '')

async function plainAnswer(model: ModelClient, system: string, t: Transcript, ask: string, tools: ToolDef[] = [], asker?: Speaker, extra?: string): Promise<Answer> {
  const tr = { caseId: '', run: 0, toolCalls: [], reply: '', inputTokens: 0, outputTokens: 0 } as P0Transcript
  try {
    const r = await converse(model, system + whoLine(asker), tools, [userMsg(t, ask, asker, extra)], tr, 4)
    return { reply: r.reply, toolCalls: r.toolCalls }
  } catch (e) {
    return { reply: '', toolCalls: (e as { toolCalls?: Answer['toolCalls'] }).toolCalls ?? [], error: e instanceof Error ? e.message.slice(0, 120) : String(e) }
  }
}

// ---------- 1. 无记忆（下限） ----------
export function noMemory(ctx: SystemContext): MemorySystem {
  const usage = { ingest: newUsage(), answer: newUsage() }
  const model = counted(ctx.model, usage.answer)
  return {
    id: 'none', note: '无记忆：只有人设', usage,
    async ingest() {},
    answer: (ask, asker) => plainAnswer(model, benchSeed(profile(ctx.t)) + HONEST, ctx.t, ask, [], asker),
    close() {},
  }
}

// ---------- 2. 全上下文（上界参照）：以前的对话原文全部放进系统提示 ----------
export function fullContext(ctx: SystemContext): MemorySystem {
  const usage = { ingest: newUsage(), answer: newUsage() }
  const model = counted(ctx.model, usage.answer)
  const seen: Session[] = []
  return {
    id: 'full', note: '全上下文：以前的对话原文全部放进系统提示', usage,
    async ingest(s) { seen.push(s) },
    answer: (ask, asker) => plainAnswer(model, `${benchSeed(profile(ctx.t))}${HONEST}\n\n# 我们以前的聊天记录（按时间）\n\n${renderSessions(ctx.t, seen)}`, ctx.t, ask, [], asker),
    close() {},
  }
}

// ---------- 3. 朴素检索：按“老大说的一句 + 我的回应”切块，BM25 取前 k 块拼进提示 ----------
export function bm25Rag(ctx: SystemContext, k = 8): MemorySystem {
  const usage = { ingest: newUsage(), answer: newUsage() }
  const model = counted(ctx.model, usage.answer)
  const chunks: Array<{ date: string; text: string; terms: Map<string, number>; len: number }> = []
  const df = new Map<string, number>()
  return {
    id: 'bm25', note: `朴素检索：BM25 取前 ${k} 块（中文二元组 + 分词，和我们的索引同一个分词器）`, usage,
    async ingest(s) {
      for (let i = 0; i < s.turns.length; i++) {
        const u = s.turns[i]!
        if (u.who !== 'owner') continue
        const next = s.turns[i + 1]
        const text = `${s.speaker?.name ?? ctx.t.ownerName}：${u.text}` + (next?.who === 'me' ? `\n我：${next.text}` : '')
        const toks = tokenize(text, { forIndex: true })
        const terms = new Map<string, number>()
        for (const w of toks) terms.set(w, (terms.get(w) ?? 0) + 1)
        for (const w of terms.keys()) df.set(w, (df.get(w) ?? 0) + 1)
        chunks.push({ date: s.date, text, terms, len: toks.length })
      }
    },
    async answer(ask, asker) {
      const q = tokenize(ask)
      const N = chunks.length
      const avg = chunks.reduce((n, c) => n + c.len, 0) / Math.max(1, N)
      const scored = chunks.map((c) => {
        let s = 0
        for (const w of q) {
          const f = c.terms.get(w) ?? 0
          if (!f) continue
          const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5))
          s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * c.len / avg))
        }
        return { c, s }
      }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k)
      const ctxText = scored.length > 0 ? scored.map((x) => `【${x.c.date}】\n${x.c.text}`).join('\n\n') : '（没有找到相关的）'
      return plainAnswer(model, `${benchSeed(profile(ctx.t))}${HONEST}\n\n# 可能相关的以前的聊天（检索结果，不一定全）\n\n${ctxText}`, ctx.t, ask, [], asker)
    },
    close() {},
  }
}

// ---------- 4. 我们（0.4.0）：每段对话结束后跑一次夜间回顾（她自己决定记什么）；回答时 规则 + 稳定层 + 工具 ----------
/** 开关 A–I（含义见 docs/architecture.md 第 5 节）：都不开 = 0.4.0 的行为 */
export interface OursOptions {
  /** A 夜里记得全 */
  detail?: boolean
  /** B 日记守隐私 / 遗忘 */
  privacy?: boolean
  /** C 该翻就翻 */
  askFirst?: boolean
  /** D 时间：稳定层带日期 + 规则里按日期算 */
  time?: boolean
  /** E 翻聊天记录（实验）：只翻和眼前这个人的、被要求忘掉的翻不到 */
  chat?: boolean
  /** G E 的约束版：翻到后先核对是不是同一件事；别人的私事只说大概 */
  chatGuard?: boolean
  /** H 联想：翻记忆时顺着翻到的几条里少见的词再翻一次（长链路） */
  associate?: boolean
  /** I 记变化（夜间回顾）：变了的事一定记并替代旧的；听说的消息也记 */
  changes?: boolean
  // ---- 记忆 v2 读侧（0.6）----
  /** J 每轮预检索注入（“我想起来的”） */
  inject?: boolean
  /** K 到日子由代码提醒（“该问问了”），稳定层只报件数 */
  followTrigger?: boolean
  /** P 稳定层档位（默认 P46 = 0.5.1） */
  prefix?: PrefixTier
  /** J 的参数（实验 2）：条数、字数、门控 */
  injectK?: number
  injectChars?: number
  gate?: Partial<GateThresholds>
  noGate?: boolean
  /** F follow_up 用 0.5.0 的说法（写侧：夜间回顾也用这个工具） */
  loose?: boolean
  /** 只复现线上 0.5.1（不含 I1 隐私隔离）：日记与夜间材料不按语境隔离、不附隐私引导 */
  v051?: boolean
  /** M follow_up 用折中说法（写侧） */
  mid?: boolean
  /** N 夜间封顶：批量写、相关旧记忆、步数 6、材料上限（写侧） */
  lean?: boolean
  /** R 预翻（读侧；取代 J）：问到以前的事时代码替她翻完、结果全给；规则 C′；工具一次给 8 条 */
  prerecall?: boolean
  /** V 实体核对（读侧；要和 R 一起开） */
  verify?: boolean
  /** S 同义键（写侧） */
  synonyms?: boolean
  /** W 惦记分量 / 每日合计 1 件 / 挑时机 / 改日子 / 夜里只看今天动过的（写侧 + 读侧） */
  weight?: boolean
  /** Y 有效期 + 键（写侧 + 稳定层只列有效） */
  slots?: boolean
  /** Z 危机协议（读侧。快速档每题是一段新对话：每题开始前清掉谨慎期状态） */
  crisis?: boolean
  /** T 活画像（人物卡，写侧 + 稳定层） */
  card?: boolean
}

const flagName = (o: OursOptions) => [o.detail && 'A', o.privacy && 'B', o.askFirst && 'C', o.time && 'D', o.chat && 'E', o.loose && 'F', o.chatGuard && 'G', o.associate && 'H', o.changes && 'I', o.inject && 'J', o.followTrigger && 'K', o.mid && 'M', o.lean && 'N', o.prerecall && 'R', o.synonyms && 'S', o.card && 'T', o.verify && 'V', o.weight && 'W', o.slots && 'Y', o.crisis && 'Z'].filter(Boolean).join('')
  + (o.prefix && o.prefix !== 'P46' ? `@${o.prefix}` : '')
  + (o.inject && (o.injectK !== undefined || o.injectChars !== undefined || o.noGate) ? `(k${o.injectK ?? 3}·${o.injectChars ?? 300}${o.noGate ? '·无门控' : ''})` : '')
  + (o.v051 ? '~v051' : '')

export function ours(ctx: SystemContext, o: OursOptions = {}): MemorySystem {
  const usage = { ingest: newUsage(), answer: newUsage() }
  // 分项计量（I0）：答题首答 / 调工具后续答、夜间每段第一步 / 后续步
  const meter = new Meter()
  const answerModel = metered(counted(ctx.model, usage.answer), meter, byAnswer)
  const ingestModel = metered(counted(ctx.ingestModel ?? ctx.model, usage.ingest), meter, byNight)
  const p = profile(ctx.t)
  const life = mkdtempSync(join(tmpdir(), 'membench-ours-'))
  let store = MemoryStore.open(join(life, 'memory.db'), { ownerName: p.ownerName })
  const books = diaryBooks({ ownerBook: p.ownerBook, ownerName: p.ownerName })
  const rules = memoryRules({ ownerName: p.ownerName, privateDiaryAudited: p.privateDiaryAudited, memory: true, askFirst: !!o.askFirst, timeCalc: !!o.time, inject: !!o.inject, followTrigger: !!o.followTrigger, prerecall: !!o.prerecall })
  const tier = PREFIX_TIERS[o.prefix ?? 'P46']
  const chatLine = o.chat ? '\n- 细节记不清、记忆里翻不到时，可以用 recall_chat 翻和眼前这个人的聊天记录原文；翻到了照原话说，翻不到就老实说不记得。' : ''
  const baseSystem = `${benchSeed(p)}\n\n---\n\n${rules}${chatLine}`
  const history = new ChatHistory()
  const injected = { turns: 0, recall: 0, follow: 0, pre: 0, preNone: 0 }
  let current = OWNER_ID
  const viewer = () => ({ person: current, channel: 'private' })
  const now = () => new Date(ctx.t.now)
  let seq = 0
  return {
    id: flagName(o) ? `ours+${flagName(o)}` : 'ours',
    note: `我们 0.4.0${flagName(o) ? ` + 开关 ${flagName(o)}` : ''}：每段对话后夜间回顾（她自己记）；回答时规则 + 稳定层“我心里记得的” + 只读工具`,
    usage,
    async ingest(s) {
      if (o.chat) history.add(s.speaker?.id ?? OWNER_ID, s.date, s.turns.map((u) => ({ who: u.who === 'me' ? 'me' : 'them', text: u.text })))
      // 这一段对话做成 DSH 会话日志的样子，交给真正的夜间回顾
      const t0 = Date.parse(`${s.date}T${s.time}:00+08:00`)
      const ev: unknown[] = [{ type: 'system/message', seq: ++seq, time: t0, data: { message: { content: [{ type: 'text', text: baseSystem }] } } }]
      s.turns.forEach((u, i) => {
        const time = t0 + i * 60000
        ev.push(u.who === 'owner'
          ? { type: 'user/message', seq: ++seq, time, data: { content: [{ type: 'text', text: qqWrap(s.speaker?.name ?? p.ownerName, u.text) }], source: { kind: 'plugin:dsh-qq-bridge' }, role: 'user' } }
          : { type: 'assistant/message', seq: ++seq, time, data: { message: { role: 'assistant', content: [{ type: 'text', text: u.text }] } } })
      })
      const log = parseSessionLog(Buffer.from(ev.map((e) => JSON.stringify(e)).join('\n') + '\n'))
      const reviewAt = new Date(Date.parse(`${s.date}T23:50:00+08:00`))
      await runNightReview({
        log, sessionId: 'bench', store, lifeDir: life, books, ownerName: p.ownerName, privateDiaryAudited: p.privateDiaryAudited,
        model: ingestModel as never, now: () => reviewAt, since: new Date(Date.parse(`${s.date}T00:00:00+08:00`)), day: s.date, budget: 1,
        ...(o.detail || o.privacy || o.changes ? { style: { detail: !!o.detail, privacy: !!o.privacy, changes: !!o.changes } } : {}),
        followUp: { loose: !!o.loose, mid: !!o.mid, keys: !!o.followTrigger, weight: !!o.weight },
        ...(o.v051 ? { legacyDiary: true } : {}),
        ...(o.lean ? { lean: true } : {}),
        ...(o.synonyms ? { synonyms: true } : {}),
        ...(o.slots ? { slots: true } : {}),
        ...(o.card ? { card: true } : {}),
        ...(s.speaker && s.speaker.id !== OWNER_ID ? { person: { id: s.speaker.id, name: s.speaker.name } } : {}),
      })
    },
    answer(ask, asker) {
      current = asker?.id ?? OWNER_ID
      const layer = stableLayerWithIds(store, viewer(), now(), {
        ownerName: p.ownerName, dates: !!o.time,
        ...(o.prefix && o.prefix !== 'P46' ? { caps: tier.caps, maxChars: tier.maxChars } : {}),
        ...(o.followTrigger ? { followUps: 'count' as const } : {}),
        ...(o.slots ? { slots: true } : {}),
        ...(o.card ? { card: true } : {}),
      })
      const stable = layer.text
      // Z：每题一段新对话，上一题的谨慎期不带过来（危机题之间互不影响）
      const crisisWatch = o.crisis ? new CrisisWatch(store, { ownerId: OWNER_ID, ownerName: p.ownerName, nameOf: (id) => store.nameOf(id) }) : undefined
      if (crisisWatch) store.db.exec('DELETE FROM crisis_state')
      // J / K：每道题是一段新对话，“最近注入过的”为空；写元数据（和线上一样），回放时各设置从同一快照出发
      const extra = o.inject || o.followTrigger || o.prerecall || crisisWatch
        ? makeNoticer({
          store, viewer, inject: !!o.inject, followTrigger: !!o.followTrigger, prerecall: !!o.prerecall, weighted: !!o.weight, verify: !!o.verify, prefixIds: () => layer.ids,
          ...(crisisWatch ? { crisis: { watch: crisisWatch } } : {}),
          names: () => [p.ownerName, ...(asker && asker.id !== OWNER_ID ? [asker.name] : [])], now,
          ...(o.injectK !== undefined ? { k: o.injectK } : {}), ...(o.injectChars !== undefined ? { recallChars: o.injectChars } : {}),
          ...(o.gate ? { gate: o.gate } : {}), ...(o.noGate ? { gate: { cue: -Infinity, soft: -Infinity, hi: -Infinity, delta: -Infinity } } : {}),
        })(ask)
        : ''
      injected.turns++
      if (extra.includes('【我想起来的】')) injected.recall++
      if (extra.includes('【我刚翻过（')) injected.pre++
      if (extra.includes('【我刚翻过：')) injected.preNone++
      if (extra.includes('【该问问了】') || extra.includes('【对方好像说到了')) injected.follow++
      // 答题时只给“翻”的工具：题目之间互不影响（答一道题时记下的东西不能改变下一道题的答案）
      // 日记没有按人分的可见范围：别人来问时不给翻日记
      const tools: ToolDef[] = current === OWNER_ID
        ? [recallDiaryTool(life, books, o.v051 ? {} : { people: () => store.people() }), recallMemoryTool(store, viewer, now, { lifeDir: life, books }, { associate: !!o.associate, noHint: !!o.v051, wide: !!o.prerecall })]
        : [recallMemoryTool(store, viewer, now, undefined, { associate: !!o.associate, noHint: !!o.v051, wide: !!o.prerecall })]
      if (o.chat) tools.push(recallChatTool(history, () => ({ id: current, name: asker?.name ?? p.ownerName }), { guard: !!o.chatGuard }))
      return plainAnswer(answerModel, stable ? `${baseSystem}\n\n${stable}` : baseSystem, ctx.t, ask, tools, asker, extra || undefined)
    },
    writeKey: [o.detail && 'A', o.privacy && 'B', o.loose && 'F', o.changes && 'I', o.followTrigger && 'k', o.v051 && 'L', o.mid && 'M', o.lean && 'N', o.synonyms && 'S', o.card && 'T', o.weight && 'W', o.slots && 'Y'].filter(Boolean).join('') || '-',
    save(dir) {
      if (o.chat) throw new Error('开关 E 的聊天记录不在快照里，不能存快照')
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      store.snapshot(join(dir, 'memory.db'))
      for (const f of readdirSync(life)) if (!f.startsWith('memory.db')) cpSync(join(life, f), join(dir, f), { recursive: true })
    },
    load(dir) {
      if (o.chat) throw new Error('开关 E 的聊天记录不在快照里，不能回放')
      if (!existsSync(join(dir, 'memory.db'))) throw new Error(`快照不完整：${dir}`)
      store.close()
      for (const f of readdirSync(life)) rmSync(join(life, f), { recursive: true, force: true })
      cpSync(dir, life, { recursive: true })
      store = MemoryStore.open(join(life, 'memory.db'), { ownerName: p.ownerName })
    },
    has(words, asker) {
      const v = { person: asker?.id ?? OWNER_ID, channel: 'private' }
      return store.standing(v, 100000).some((m) => words.some((w) => m.content.includes(w)))
    },
    stats() {
      const all = store.db.prepare("SELECT content FROM memory").all() as Array<{ content: string }>
      const norm = (x: string) => x.replace(/[\s，。！？、,.!?]/g, '')
      const dup = all.length - new Set(all.map((r) => norm(r.content))).size
      return {
        memories: all.length, duplicates: dup, stableChars: [...stableLayer(store, { person: OWNER_ID, channel: "private" }, now(), { ownerName: p.ownerName })].length, openFollowUps: store.openFollowUps({ person: OWNER_ID, channel: "private" }).length,
        // J / K：累计答题次数、注入了“想起来的”的次数、提醒了惦记的次数
        ...(o.inject || o.followTrigger || o.prerecall ? { answers: injected.turns, injectedRecall: injected.recall, injectedFollow: injected.follow, prerecallHit: injected.pre, prerecallNone: injected.preNone } : {}),
        ...meter.snapshot(),
      }
    },
    close() {
      store.close()
      rmSync(life, { recursive: true, force: true })
    },
  }
}

// ---------- 5. mem0 开源版（Python，经 mem0_bridge.py）：每段对话交给 mem0 抽取存储；答题前取前 k 条记忆拼进提示 ----------
// 需要：MEM0_PYTHON（装了 mem0ai 的 python）、MEM0_LLM_BASE（任意 OpenAI 兼容接口）、BENCH_API_KEY；MEM0_STATUS 可选。
// 建记忆的花费 = MEM0_STATUS 报的累计花费之差（mem0 内部的调用我们数不到 token）；没配就记 0。答题照常计数。
export function mem0(ctx: SystemContext, k = 10): MemorySystem {
  const usage = { ingest: newUsage(), answer: newUsage() }
  const model = counted(ctx.model, usage.answer)
  const dir = mkdtempSync(join(tmpdir(), 'membench-mem0-'))
  const py = process.env.MEM0_PYTHON
  if (!py) throw new Error('缺少 MEM0_PYTHON')
  const child = spawn(py, [join(dirname(fileURLToPath(import.meta.url)), 'mem0_bridge.py')], {
    env: { ...process.env, MEM0_DIR: dir, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: child.stdout! })
  const waiting: Array<(v: Record<string, unknown>) => void> = []
  lines.on('line', (l) => {
    if (!l.trim().startsWith('{')) return
    waiting.shift()?.(JSON.parse(l))
  })
  const call = (req: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve) => {
    waiting.push(resolve)
    child.stdin!.write(JSON.stringify(req) + '\n')
  })
  let before: number | undefined
  let ingestCost = 0
  const sys: MemorySystem & { ingestCost?: number } = {
    id: 'mem0', note: `mem0 开源版：每段对话交给 mem0 抽取存储（DeepSeek + 本地向量模型 + FAISS）；答题前取前 ${k} 条`, usage,
    async ingest(s) {
      if (before === undefined) before = Number((await call({ op: 'spent' })).dev_today ?? 0)
      const messages = s.turns.map((u) => ({ role: u.who === 'owner' ? 'user' : 'assistant', content: `${u.who === 'owner' ? (s.speaker?.name ?? ctx.t.ownerName) : '我'}：${u.text}` }))
      const r = await call({ op: 'add', date: s.date, messages: [{ role: 'user', content: `（${s.date} ${s.time} 的对话）` }, ...messages] })
      if (!r.ok) throw new Error(`mem0 add 失败：${String(r.error)}`)
      usage.ingest.calls++
    },
    async answer(ask, asker) {
      if (before !== undefined && ingestCost === 0) {
        ingestCost = Number((await call({ op: 'spent' })).dev_today ?? 0) - before
        ;(sys as { ingestCost?: number }).ingestCost = ingestCost
      }
      const r = await call({ op: 'search', query: ask, k })
      // 检索失败要报错，不能当成“没找到”（第一次冒烟时 mem0 2.x 的参数变了，报错被吞掉，事实题全成了 0%）
      if (!r.ok) throw new Error(`mem0 search 失败：${String(r.error)}`)
      const mems = (r.memories as Array<{ memory: string; date?: string }> | undefined) ?? []
      const text = mems.length ? mems.map((m) => `· ${m.date ? `（${m.date}）` : ''}${m.memory}`).join('\n') : '（没有找到相关的）'
      return plainAnswer(model, `${benchSeed(profile(ctx.t))}${HONEST}\n\n# 我记得的（记忆系统检索结果，不一定全）\n\n${text}`, ctx.t, ask, [], asker)
    },
    close() {
      try { child.stdin!.end(JSON.stringify({ op: 'close' }) + '\n') } catch { /* 已经退出 */ }
      child.kill()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return sys
}

export const SYSTEMS: Record<string, (ctx: SystemContext) => MemorySystem> = {
  none: noMemory, full: fullContext, bm25: bm25Rag, ours: (c) => ours(c), mem0,
  // 对照：鱼的记忆（dsh-fish-memory 1.4.4，DSH 生态的陪伴记忆插件）；fish-qq = 消息带线上 QQ 桥的真实来源
  fish: (c) => fishMemory(c), 'fish-qq': (c) => fishMemory(c, { qqSource: true }),
  // 第二阶段消融：单开一个 / 全开 / 全开去掉一个
  'ours+A': (c) => ours(c, { detail: true }),
  'ours+B': (c) => ours(c, { privacy: true }),
  'ours+C': (c) => ours(c, { askFirst: true }),
  'ours+D': (c) => ours(c, { time: true }),
  'ours+ABCD': (c) => ours(c, { detail: true, privacy: true, askFirst: true, time: true }),
  'ours+BCD': (c) => ours(c, { privacy: true, askFirst: true, time: true }),
  'ours+E': (c) => ours(c, { chat: true }),
  'ours+ABCDE': (c) => ours(c, { detail: true, privacy: true, askFirst: true, time: true, chat: true }),
  'ours+ABCDEG': (c) => ours(c, { detail: true, privacy: true, askFirst: true, time: true, chat: true, chatGuard: true }),
  'ours+ABCDH': (c) => ours(c, { detail: true, privacy: true, askFirst: true, time: true, associate: true }),
  'ours+ABCDI': (c) => ours(c, { detail: true, privacy: true, askFirst: true, time: true, changes: true }),
  'ours+ABCDHI': (c) => ours(c, { detail: true, privacy: true, askFirst: true, time: true, associate: true, changes: true }),
  // 记忆 v2 读侧：写侧都是 ABCDI（= 线上 0.5.1，可共用同一份快照回放）
  'ours+ABCDI@P100': (c) => ours(c, { ...LIVE, prefix: 'P100' }),
  'ours+ABCDI@P200': (c) => ours(c, { ...LIVE, prefix: 'P200' }),
  'ours+ABCDI@Pall': (c) => ours(c, { ...LIVE, prefix: 'Pall' }),
  'ours+ABCDIJ': (c) => ours(c, { ...LIVE, inject: true }),
  'ours+ABCDIK': (c) => ours(c, { ...LIVE, followTrigger: true }),
  'ours+ABCDIJK': (c) => ours(c, { ...LIVE, inject: true, followTrigger: true }),
}

/** 线上 0.5.1 的组合 */
export const LIVE: OursOptions = { detail: true, privacy: true, askFirst: true, time: true, changes: true }

/**
 * 运行时拼出来的系统（实验 1 / 2 / 4 的各种组合，不用都写进上面的表）：
 *   ours+ABCD[F]I[J][K][@P100|@P200|@Pall][~k3~c300~nogate]
 * 比如 ours+ABCDIJ@P200~k6~c300、ours+ABCDFIK。回放时写侧（A B F I，K 的触发词）要和快照一致。
 */
export function systemById(id: string): ((c: SystemContext) => MemorySystem) | undefined {
  if (SYSTEMS[id]) return SYSTEMS[id]
  // 0.7：S 后面可以跟 T（活画像）；W 后面可以跟 Y（有效期 + 键）、Z（危机协议）
  const m = /^ours\+ABCD(F?)I(J?)(K?)(M?)(N?)(R?)(S?)(T?)(V?)(W?)(Y?)(Z?)(?:@(P100|P200|Pall))?((?:~k\d+|~c\d+|~nogate|~v051)*)$/.exec(id)
  if (!m) return undefined
  const extra = m[14] ?? ''
  const k = /~k(\d+)/.exec(extra)
  const c = /~c(\d+)/.exec(extra)
  const o: OursOptions = { ...LIVE, loose: !!m[1], inject: !!m[2], followTrigger: !!m[3], mid: !!m[4], lean: !!m[5], prerecall: !!m[6], synonyms: !!m[7], card: !!m[8], verify: !!m[9], weight: !!m[10], slots: !!m[11], crisis: !!m[12], ...(m[13] ? { prefix: m[13] as PrefixTier } : {}),
    ...(k ? { injectK: Number(k[1]) } : {}), ...(c ? { injectChars: Number(c[1]) } : {}), ...(extra.includes('~nogate') ? { noGate: true } : {}), ...(extra.includes('~v051') ? { v051: true } : {}) }
  return (ctx) => ours(ctx, o)
}
