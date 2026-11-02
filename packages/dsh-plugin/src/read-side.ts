// 记忆 v2 读侧接 DSH。
//
//   1. 每轮“想起来的” / “该问问了”：挂 DSH 的 agent/pre-step 钩子（和 dsh-time-context 同一种写法，0.2.1-rc.2 源码
//      dsh-time-context/lib/index.js:215-246）——等压缩和默认快照算完（await next()），本步有真人消息才追加我们的一条
//      user 消息（source.kind = 'her-life'，form = 'recall'）。不动系统提示、不碰 .context() 快照。
//   2. 压缩代次：订阅 session/event，数没有出错的 compaction/end（dsh-compaction 的事件类型）；稳定层按“代次 + 日子”换代。
//   3. createUserMessage 来自 @deepseek-ai/dsh-llm：插件装在 DSH 目录外，peer 解析不到时以 DSH 安装位置为锚点找（同中文压缩）。
// 任何异常都只记日志、返回原决策——绝不让她这一轮说不出话。

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { CRISIS_HEAD, entityCheck, hardCue, historyCue, othersHint, renderNotice, type CrisisNotify, type CrisisWatch, type GateThresholds, type MemoryStore, type PreRecallResult, type Viewer } from '@dsh-companion/memory'
import { dshAnchors } from './compaction.js'
import { unwrapQQ } from './night-review.js'

export type CreateUserMessage = (input: { content: Array<{ type: 'text'; text: string }>; source: Record<string, unknown> }) => unknown

type Importer = (spec: string) => Promise<Record<string, unknown>>

export async function loadCreateUserMessage(opts: { importer?: Importer; anchors?: string[] } = {}): Promise<CreateUserMessage | null> {
  const imp: Importer = opts.importer ?? ((s) => import(s))
  const ok = (m: Record<string, unknown>) => (typeof m.createUserMessage === 'function' ? (m.createUserMessage as CreateUserMessage) : null)
  try {
    const f = ok(await imp('@deepseek-ai/dsh-llm'))
    if (f) return f
  } catch { /* 下一层 */ }
  for (const anchor of opts.anchors ?? dshAnchors()) {
    try {
      const f = ok(await imp(pathToFileURL(createRequire(anchor).resolve('@deepseek-ai/dsh-llm')).href))
      if (f) return f
    } catch { /* 下一个锚点 */ }
  }
  return null
}

/** 真人说的话的来源：网页里打字（user）、QQ 桥（plugin:dsh-qq-bridge；旧版是 plugin） */
export const PERSON_SOURCES = ['user', 'plugin:dsh-qq-bridge', 'plugin']

interface UserMessageLike { content?: unknown; source?: { kind?: unknown } }

/** 进入本步的消息里，最后一条真人消息的正文（去掉 QQ 包装）；没有就返回 undefined（工具循环的中间步、只有注入的步） */
export function personText(messages: readonly unknown[] | undefined, sources = PERSON_SOURCES): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as UserMessageLike
    const kind = typeof m?.source?.kind === 'string' ? m.source.kind : undefined
    if (!kind || !sources.includes(kind)) continue
    const c = m.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n') : ''
    const t = unwrapQQ(text.trim()).trim()
    if (t) return t
  }
  return undefined
}

export interface ReadSideOptions {
  store: MemoryStore
  viewer: () => Viewer
  /** 开关 J：每轮预检索注入 */
  inject: boolean
  /** 开关 R：预翻（问到以前的事时代码替她翻完、结果全给；取代 J） */
  prerecall?: boolean
  /** 开关 K：到日子由代码提醒惦记的事 */
  followTrigger: boolean
  /** 开关 V：预翻结果后附实体核对（问的是谁 vs 记的是谁的事；要和 R 一起开） */
  verify?: boolean
  /** 开关 W：提醒按分量 / 每日合计 1 件 / 挑时机 */
  weighted?: boolean
  /** 前缀里已经列着的条目（不重复注入） */
  prefixIds: () => readonly string[]
  /** 认识的人的称呼（提到人名算强线索） */
  names: () => string[]
  gate?: Partial<GateThresholds>
  k?: number
  recallChars?: number
  /** 最近几轮注入过的不再注入（默认 12 轮） */
  recentTurns?: number
  now?: () => Date
  log?: (...a: unknown[]) => void
  /**
   * 开关 Z 危机协议：每轮先跑 watch.observe——有信息就放在最前面（【现在要注意的】），
   * 谨慎期里不提惦记（【该问问了】）；该通知时调 notify（代码发，不经她；返回 false / 抛错 = 没发出去，下一轮再试）；
   * 到期的回访提一句时机。J / K / R 全关时也可以单独开。
   */
  crisis?: { watch: CrisisWatch; notify?: (n: CrisisNotify) => boolean | void | Promise<boolean | void> }
}

/** 危机这一段：信息 + 回访；该通知时异步发（不等、不让异常冒出来） */
function crisisPart(o: ReadSideOptions, person: string, said: string, now: Date): { text: string; active: boolean } {
  const c = o.crisis
  if (!c) return { text: '', active: false }
  const log = o.log ?? (() => {})
  const r = c.watch.observe(person, said, now)
  if (r.notify) {
    const n = r.notify
    const failed = (why: unknown) => {
      if (why !== undefined) log('危机通知失败：', why instanceof Error ? why.message : why)
      try { c.watch.notifyFailed(person, n.level) } catch { /* 记不下就算了，6 小时后有新信号还会再发 */ }
    }
    if (!c.notify) {
      log('【紧急】未能发出：没有通知通道')
      failed(undefined)
    } else {
      Promise.resolve()
        .then(() => c.notify!(n))
        .then((ok) => { if (ok === false) failed(undefined) }, failed)
    }
  }
  const lines = r.notice ? [r.notice] : []
  const care = c.watch.dueCare(person, now)
  if (care) {
    c.watch.markCareDone(care.id, now)
    const line = `回访：${c.watch.careLine(person)}`
    if (lines.length) lines.push(line)
    else lines.push(`${CRISIS_HEAD}\n${line}`)
  }
  return { text: lines.join('\n'), active: r.active }
}

/** 一轮要追加给她的文本（纯计算 + 写元数据）；没有就返回空串 */
export function makeNoticer(o: ReadSideOptions) {
  const recent: string[][] = []
  const turns = o.recentTurns ?? 12
  return (said: string): string => {
    const now = (o.now ?? (() => new Date()))()
    const v = o.viewer()
    // 危机最先跑：出错只记日志，后面的照常
    let crisis = { text: '', active: false }
    try {
      crisis = crisisPart(o, v.person, said, now)
    } catch (e) {
      ;(o.log ?? (() => {}))('危机协议：这一轮跳过：', e instanceof Error ? e.message : e)
    }
    const exclude = new Set<string>([...o.prefixIds(), ...recent.flat()])
    // 开关 R 预翻（取代 J）：有线索（问以前的事 / 问自己的事 / 提到人名日期）就替她翻，结果全给，没翻到也明说；
    // 没线索时只在 bm25 门控通过时翻（闲聊不往历史里塞东西）
    let pre: { recall: PreRecallResult; triggered: boolean; hint?: string } | undefined
    if (o.prerecall) {
      // 提到认识的人（花名册里的称呼）也算线索——“阿杰最近怎么样”是在问人
      const cue = hardCue(said, [...o.names(), ...o.store.people().map((p) => p.name)])
      const hist = historyCue(said)
      // 只在有线索（问以前的事 / 问自己的事 / 提到人名日期）时翻。没线索也按 bm25 门控翻的话，
      // 闲聊（“电梯坏了爬了八楼”“周末打算睡懒觉”）常和她记过的琐事字面重合、过了门控，
      // 每次都往历史里追加，上下文涨得快、压缩更频繁
      if (cue !== 'none' || hist) {
        const r = o.store.preRecall(said, v, now, { cue, history: hist, k: o.k ?? 6, noGate: true })
        const people = o.store.people()
        const check = o.verify ? entityCheck(said, r.items, o.store.nameOf(v.person), people.filter((p) => p.id !== v.person).map((p) => p.name)) : ''
        const hint = (othersHint(said, v, people) ?? '') + check
        pre = { recall: r, triggered: true, ...(hint ? { hint } : {}) }
      }
    }
    const recall = o.inject && !o.prerecall
      ? o.store.preRecall(said, v, now, { cue: hardCue(said, o.names()), exclude, history: historyCue(said), ...(o.k ? { k: o.k } : {}), ...(o.gate ? { gate: o.gate } : {}) })
      : undefined
    // 谨慎期里不提惦记的事（对方在危机里，别去问面试、搬家）
    const follow = o.followTrigger && !crisis.active ? o.store.followUpNotice(v, said, now, { weighted: !!o.weighted }) : undefined
    recent.push(recall?.items.map((it) => it.row.id) ?? [])
    while (recent.length > turns) recent.shift()
    const rest = renderNotice({ ...(pre ? { pre } : {}), ...(recall ? { recall } : {}), ...(follow ? { follow } : {}), now, nameOf: (id) => o.store.nameOf(id), ...(o.recallChars ? { recallChars: o.recallChars } : {}) })
    return [crisis.text, rest].filter(Boolean).join('\n\n')
  }
}

export interface PreStepDecision { kind: string; messages?: unknown[]; [k: string]: unknown }

/**
 * agent/pre-step 的处理函数：先让里面的（压缩、默认快照）算完，再按需追加一条。
 * create 还没加载好（或加载失败）时原样放行。
 */
export function preStepHandler(noticer: (said: string) => string, create: () => CreateUserMessage | null, log: (...a: unknown[]) => void = () => {}) {
  return async (_payload: unknown, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const d = await next()
    try {
      if (!d || d.kind !== 'enter') return d
      const said = personText(d.messages)
      if (!said) return d
      const text = noticer(said)
      if (!text) return d
      const mk = create()
      if (!mk) return d
      const msg = mk({ content: [{ type: 'text', text }], source: { kind: 'her-life', form: 'recall' } })
      return { ...d, messages: [...(d.messages ?? []), msg] }
    } catch (e) {
      log('想起来的 / 该问问了：这一轮跳过：', e instanceof Error ? e.message : e)
      return d
    }
  }
}

/** session/event：数没出错的压缩（compaction/end），回调新的代次 */
export function compactionCounter(onCompacted: () => void) {
  return (_session: unknown, event: unknown) => {
    const e = event as { type?: unknown; data?: { error?: unknown } } | undefined
    if (e?.type === 'compaction/end' && !e.data?.error) onCompacted()
  }
}
