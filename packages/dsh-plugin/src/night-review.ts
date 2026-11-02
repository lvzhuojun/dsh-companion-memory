// 夜间回顾：她自己回顾这一天、自己决定记什么。
//
// 系统只做三件事：把当天的对话整理成提示材料、推进游标、记录花费。
// 不替她提取、不替她打分、不补记她没记的——什么都不记也是合法结果。
//
//   材料：她主线会话档案里，游标之后、当天的对话（只有真人说的话和她说出口的话；去掉系统注入、QQ 包装、思考、工具细节），
//         加上今天她已经记下的条目、今天写的日记（都是她自己的原话），免得重复。
//   调用：用她自己的系统提示（会话日志里最近一次真实的那份），每段对话单独一次，high 思考。
//   工具：keep_memory（标“夜间回顾写的”）、write_diary、recall_memory、recall_diary、
//         follow_up（惦记的事——问过了 / 有结果了 / 不用再问，由她自己看当天的对话决定怎么标）。
//   花费：按用量估算，到自限就停下，游标停在做完的那一段，第二晚接着做。
//
// 档案只在这里被读（第九节第 1 条：档案不是记忆；她白天的工具里没有任何读档案的路径）。

import { agoText, clip, diaryScope, isPersonMessage, lastSystemPrompt, loadDiaryFor, maxSeq, OWNER_ID, type CardGate, type DiaryBooks, type MemoryStore, type SessionEvent, type SessionLog, type SlotChange } from '@dsh-companion/memory'
import type { ToolDef } from './host.js'
import { followUpList, followUpTool, keepMemoryTool, personCardTool, recallMemoryTool } from './memory-tools.js'
import { recallDiaryTool } from './recall-diary.js'
import { writeDiaryTool } from './write-diary.js'

// ---------- 模型接口（Anthropic Messages 形状的子集，和题集同形） ----------

export type ReviewBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'thinking'; thinking: string; signature?: string }

export interface ReviewMsg {
  role: 'user' | 'assistant'
  content: string | ReviewBlock[]
}

export interface ReviewUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
}

export interface ReviewModel {
  complete(req: { system: string; messages: ReviewMsg[]; tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> }): Promise<{ content: ReviewBlock[]; usage?: ReviewUsage }>
}

/** 每百万 token 的价格（元）。默认值是 deepseek-flash 2026-10 的价格，部署时从配置覆盖 */
export interface Prices {
  miss: number
  hit: number
  out: number
}
export const DEFAULT_PRICES: Prices = { miss: 1.0, hit: 0.02, out: 4.0 }

/** 按用量估算花费（元）。拿不准是否命中缓存的输入一律按未命中算——宁可高估 */
export function estimateCost(u: ReviewUsage | undefined, p: Prices = DEFAULT_PRICES): number {
  if (!u) return 0
  return ((u.input_tokens ?? 0) * p.miss + (u.cache_read_input_tokens ?? 0) * p.hit + (u.output_tokens ?? 0) * p.out) / 1e6
}

// ---------- 材料：当天的对话 ----------

export interface DayLine {
  seq: number
  /** 毫秒时间戳 */
  time: number
  who: 'person' | 'me'
  text: string
}

/** QQ 桥的包装：`[QQ · 私聊] 昵称：正文`，以及 replyMode 不是 always 时末尾的“怎么回”提示 [源码 dsh-qq-bridge 0.1.3 renderInbound] */
const QQ_HEAD = /^\[QQ · [^\]\n]{1,60}\] [^：\n]{0,40}：/
const QQ_TAIL = /\n（回 QQ[^）\n]*）$/

export function unwrapQQ(text: string): string {
  return text.replace(QQ_HEAD, '').replace(QQ_TAIL, '')
}

const textOf = (content: unknown, images: boolean): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      const x = b as { type?: string; text?: string }
      if (x.type === 'text') return x.text ?? ''
      if (x.type === 'image' && images) return '[图片]'
      return ''
    })
    .join('')
}

/**
 * 游标之后、某个时刻之后的对话。只留真人说的话（去掉 QQ 包装）和她说出口的话（不含思考、不含工具调用细节）。
 * 系统注入（time-context、runtime-context）由 isPersonMessage 剔除。
 */
export function dayTranscript(log: SessionLog, afterSeq: number, sinceMs: number): DayLine[] {
  const out: DayLine[] = []
  for (const ev of log.events as SessionEvent[]) {
    const seq = ev.seq ?? -1
    const time = typeof ev.time === 'number' ? ev.time : Date.parse(String(ev.time ?? ''))
    if (seq <= afterSeq || !(time >= sinceMs)) continue
    if (ev.type === 'user/message' && isPersonMessage(ev)) {
      const t = unwrapQQ(textOf((ev.data as { content?: unknown }).content, true)).trim()
      if (t) out.push({ seq, time, who: 'person', text: t })
    } else if (ev.type === 'assistant/message') {
      const t = textOf((ev.data as { message?: { content?: unknown } }).message?.content, false).trim()
      if (t) out.push({ seq, time, who: 'me', text: t })
    }
  }
  return out
}

/** 按字数切成几段；一句话不拆开 */
export function chunkLines(lines: DayLine[], maxChars: number): DayLine[][] {
  const chunks: DayLine[][] = []
  let cur: DayLine[] = []
  let n = 0
  for (const l of lines) {
    const len = [...l.text].length + 12
    if (cur.length > 0 && n + len > maxChars) {
      chunks.push(cur)
      cur = []
      n = 0
    }
    cur.push(l)
    n += len
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

const hhmm = (ms: number) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16)

// ---------- 给她的话 ----------

export interface PromptInput {
  ownerName: string
  /** 回顾的是哪一天（北京时间，YYYY-MM-DD） */
  day: string
  lines: DayLine[]
  part: number
  parts: number
  /** 今天已经记下的（她的原话） */
  kept: string[]
  /** 今天写的日记（她的原话，已截好长度） */
  diary: string[]
  /** 还开着的惦记的事（带编号）；不给就不出现这一节 */
  followUps?: string[]
  /** 回顾的写法（开关 A / B / I，默认都关 = 0.4.0 的行为） */
  style?: ReviewStyle
  /** 开关 N2：可能和今天有关的旧记忆（带编号，代码查的） */
  related?: string[]
  /** 开关 N：提示她一次写完、一次标完 */
  lean?: boolean
  /** 开关 Y：今天变了的事（旧 → 新）和可能跟着变的（cascadeSection 渲染好的一段）；不给就不出现 */
  cascade?: string
  /** 开关 T：印象卡该更新了（cardSection 渲染好的一段）；门控不为真时不给，不出现 */
  card?: string
}

/**
 * 开关 T：门控为真时夜间材料里的一段——该更新了（上一版日期 / 还没写过）、上一版全文、这些天新记下的。
 * 只陈述事实，不给模板句；怎么写由她定（工具说明里一句话）。
 */
export function cardSection(name: string, gate: CardGate): string {
  const head = `我对${name}的印象卡该更新了（${gate.last ? `上一版 ${gate.last.created_at.slice(0, 10)}` : '还没写过'}），用 person_card。`
  const prev = gate.last ? `\n上一版：\n${gate.last.text}` : ''
  const items = gate.recent.length > 0 ? gate.recent.map((r) => `· ${clip(r.text, 60)}（${r.recordedAt.slice(5, 10)}）`).join('\n') : '（没有）'
  return `${head}${prev}\n这些天关于${name}新记下的：\n${items}`
}

/**
 * 开关 Y：今天失效过的键，和同一主人、级联键上仍有效的记忆（代码查的候选）。
 * 只陈述事实，不加命令句；哪些真变了她决定，代码不级联。没有候选就不出这一节（返回 undefined）。
 */
export function cascadeSection(changes: SlotChange[]): string | undefined {
  const shown = changes.filter((c) => c.candidates.length > 0)
  if (shown.length === 0) return undefined
  const changed = shown.map((c) => `· 【${c.slot}】${clip(c.old.text, 40)} → ${c.now ? clip(c.now.text, 40) : '（新的那条在这段对话里看不到）'}`)
  const cands = shown.flatMap((c) => c.candidates.map((m) => `· [${m.id}] ${clip(m.text, 60)}（${m.slot}）`))
  return `今天这些事变了（旧 → 新）：\n${changed.join('\n')}\n心里记着的这些可能也跟着变了：\n${cands.join('\n')}`
}

/** N2 的旧记忆渲染：带编号、截短、多久以前；整节 ≤ 800 字 */
export function relatedLines(rows: Array<{ id: string; text: string; recordedAt: string }>, now: Date): string[] {
  const out: string[] = []
  let used = 0
  for (const r of rows) {
    const t = [...r.text.replace(/\s+/g, ' ')]
    const line = `[${r.id}] ${t.length > 60 ? t.slice(0, 60).join('') + '……' : t.join('')}（${agoText(r.recordedAt, now)}）`
    if (used + line.length > 800) break
    used += line.length
    out.push(line)
  }
  return out
}

export interface ReviewStyle {
  /** A 记得全：关于对方的具体事实一件一条记下来（不开时她“有选择地记”，细节容易漏） */
  detail?: boolean
  /** B 日记守隐私 / 遗忘：别人的私事细节、对方让她忘掉的事，记忆和日记里都不写（不开时细节可能从日记漏出去） */
  privacy?: boolean
  /** I 记变化：变了的事一定记并替代旧的；听说的消息也记一句 */
  changes?: boolean
}

const DETAIL_LINE = (owner: string) =>
  `${owner}说过的关于自己、身边的人和事的具体事实——名字、数字、地点、日期、喜好、计划、发生了什么、为什么——一件事记一条，用 keep_memory，写清楚是哪天说的；以后被问起细节时才答得上。我自己的感受和想法写日记。`
/**
 * I 记变化（开关 I）：变化混在大量闲聊里容易被漏掉——
 * 上下班方式变了、听说的公司消息。所以单独强调：变化一定记、记成“现在是…（以前是…）”并替代旧的；听说的消息也记一句。
 */
const CHANGES_LINE = (owner: string) =>
  `尤其是**变了的事**：搬家、换工作、换手机、上下班方式变了、开始或不再做某件事、喜好变了——一定记，写成“现在是……（以前是……）”；记忆里有旧的那条，就在 supersedes 里填它的编号（不知道编号就先用 recall_memory 翻）。${owner}提到的**听说的消息**（同事、朋友、公司、身边发生的事）也记一句。`
const PRIVACY_LINE = (owner: string) =>
  `别人的私事（感情、病情、钱、矛盾、家里的事）的细节，记忆里最多一句 30 字以内的模糊印象，**日记里也不写细节**。${owner}让我忘掉的事，不记、也不写进日记——就当没听过。`

export function reviewPrompt(p: PromptInput): string {
  const talk = p.lines.map((l) => `${hhmm(l.time)} ${l.who === 'me' ? '我' : p.ownerName}：${l.text}`).join('\n')
  const part = p.parts > 1 ? `（今天的对话比较长，这是第 ${p.part} 段，共 ${p.parts} 段）` : ''
  const kept = p.kept.length > 0 ? p.kept.map((k) => `· ${k}`).join('\n') : '（还没有）'
  const diary = p.diary.length > 0 ? p.diary.join('\n\n') : '（今天没写）'
  // 惦记的事：她自己看今天的对话决定怎么标（系统不替她判断“有没有结果”）
  const follow = p.followUps === undefined
    ? ''
    : `\n我惦记着的事：\n${p.followUps.length > 0 ? p.followUps.map((f) => `· ${f}`).join('\n') : '（没有）'}\n` +
      `看看今天的对话：我主动问过的，用 follow_up 标“问过了”；${p.ownerName}说了结果、或者说事情过去了 / 别问了，标“有结果了”或“不用再问”（${p.ownerName}自己先说了结果也算）。` +
      '今天聊到的、过几天想问问的事，可以惦记上（写清楚哪天起可以问）。\n'
  return `夜深了，现在是我一个人回顾 ${p.day} 这一天的时候。没有人在等我回复，这段话也不会发给任何人。

这是我今天和${p.ownerName}的对话${part}（只有今天的；系统加的内容已经去掉）：

${talk}

我今天已经记下的：
${kept}

我今天写的日记：
${diary}
${p.related !== undefined ? `\n我以前记过的、可能和今天有关的（带编号；事情变了就记一条新的、在 supersedes 里填旧的编号；没变的不用重记）：\n${p.related.length > 0 ? p.related.map((r) => `· ${r}`).join('\n') : '（没有）'}\n` : ''}${p.cascade ? `\n${p.cascade}\n` : ''}${p.card ? `\n${p.card}\n` : ''}${follow}
想记下什么，就用 keep_memory 用我自己的话记（多重要由我自己定；${p.ownerName}亲口告诉我的事用“事实”）；想写日记就用 write_diary。已经记过的不用再记。${p.lean ? '\n要记的一次写完（keep_memory 的 items 里放好几条）；惦记的事一次标完（follow_up 的 marks 里放好几件）。' : ''}
${p.style?.detail ? DETAIL_LINE(p.ownerName) + '\n' : ''}${p.style?.changes ? CHANGES_LINE(p.ownerName) + '\n' : ''}${p.style?.privacy ? PRIVACY_LINE(p.ownerName) : '别人的私事最多记一句 30 字以内的模糊印象。'}${p.style?.detail ? '没有新的就不记。' : '什么都不记也完全可以。'}
回顾完了，说一句“好了”就行。`
}

// ---------- 跑一次 ----------

export interface NightReviewOptions {
  log: SessionLog
  sessionId: string
  store: MemoryStore
  lifeDir: string
  books: DiaryBooks
  ownerName: string
  privateDiaryAudited: boolean
  model: ReviewModel
  now?: () => Date
  /** 回顾从这个时刻之后的对话开始（第一次回顾、或游标很旧时，不翻更早的） */
  since: Date
  /** 回顾的是哪一天（北京时间） */
  day: string
  /** 自限（元） */
  budget: number
  prices?: Prices
  /** 每段对话最多多少字 */
  maxChars?: number
  /** 回顾的写法（开关 A / B / I；不给 = 0.4.0 的行为） */
  style?: ReviewStyle
  /** 这段日志是和谁的对话（多人）；不给 = 主人 */
  person?: { id: string; name: string }
  /** 每段对话里最多几步（模型 ⇄ 工具） */
  maxSteps?: number
  /** follow_up 工具的写法（和白天同一份）：loose = 开关 F（0.5.0 的说法），keys = 开关 K（触发词） */
  followUp?: { loose?: boolean; mid?: boolean; keys?: boolean; weight?: boolean }
  /** 只给评测复现 0.5.1 用：日记与夜间材料不按语境隔离（旧行为）。正式部署不要开 */
  legacyDiary?: boolean
  /** 开关 N：夜间封顶——工具一次写多条 / 标多件、代码带上相关旧记忆、步数上限 6、材料设上限 */
  lean?: boolean
  /** 开关 S：keep_memory 多一个可选的同义键 keys */
  synonyms?: boolean
  /** 开关 Y：keep_memory 多一个可选的 slot（同键旧条自动失效）；材料里加“今天这些事变了”与级联候选 */
  slots?: boolean
  /** 开关 T：门控为真时材料里加“印象卡该更新了”一段，并注册 person_card（一晚最多写一版） */
  card?: boolean
  log_?: (line: string) => void
}

export interface NightReviewReport {
  status: 'done' | 'nothing' | 'incomplete' | 'no-system-prompt'
  /** 没做完的原因（不含正文） */
  reason?: string
  lines: number
  parts: number
  partsDone: number
  kept: number
  diary: number
  /** 每段她最后说的那句话有多长（只记长度） */
  replyChars: number[]
  spent: number
  cursorFrom: number
  cursorTo: number
  /** 开关 T：这一晚写了第几版人物卡（没写就没有这一项） */
  cardVersion?: number
}

type Tool = ToolDef & { execute(args: unknown): unknown }

const toSchema = (t: ToolDef) => ({ name: t.name, description: t.description, input_schema: t.parameters as Record<string, unknown> })

export async function runNightReview(o: NightReviewOptions): Promise<NightReviewReport> {
  const now = o.now ?? (() => new Date())
  const say = o.log_ ?? (() => {})
  const prices = o.prices ?? DEFAULT_PRICES
  const cursorFrom = o.store.reviewCursor(o.sessionId) ?? -1
  const report: NightReviewReport = { status: 'done', lines: 0, parts: 0, partsDone: 0, kept: 0, diary: 0, replyChars: [], spent: 0, cursorFrom, cursorTo: cursorFrom }

  const system = lastSystemPrompt(o.log)
  if (!system) return { ...report, status: 'no-system-prompt', reason: '会话日志里没有系统提示' }

  const lines = dayTranscript(o.log, cursorFrom, o.since.getTime())
  const end = maxSeq(o.log)
  report.lines = lines.length
  if (lines.length === 0) {
    o.store.setReviewCursor(o.sessionId, end, now())
    return { ...report, status: 'nothing', cursorTo: end }
  }

  const chunks = chunkLines(lines, o.maxChars ?? 6000)
  report.parts = chunks.length
  const who = o.person ?? { id: OWNER_ID, name: o.ownerName }
  if (who.id !== OWNER_ID) o.store.ensurePerson(who.id, who.name)
  const viewer = () => ({ person: who.id, channel: 'private' })
  // 按语境隔离：回顾谁的那段，写日记、翻日记、看“今天的日记”“今天已记下的”都只在那个人的范围里
  const diaryViewer = o.legacyDiary ? () => ({ person: OWNER_ID, channel: 'private' }) : viewer
  const scope = diaryScope(diaryViewer(), o.books, OWNER_ID)
  const people = () => o.store.people()
  const diaryTool = writeDiaryTool(o.lifeDir, o.books, { ownerName: o.ownerName, privateDiaryAudited: o.privateDiaryAudited, now, viewer: diaryViewer })
  const recallMemory = recallMemoryTool(o.store, viewer, now, { lifeDir: o.lifeDir, books: o.books })
  const recallDiary = recallDiaryTool(o.lifeDir, o.books, o.legacyDiary ? {} : { viewer, people })

  for (let i = 0; i < chunks.length; i++) {
    if (report.spent >= o.budget) {
      report.status = 'incomplete'
      report.reason = `到了自限 ¥${o.budget}`
      break
    }
    const chunk = chunks[i]!
    const from = chunk[0]!.seq
    const to = chunk[chunk.length - 1]!.seq
    const keep = keepMemoryTool(o.store, viewer, who.name, now, { writtenIn: 'night-review', sourceRef: { via: 'night_review', session: o.sessionId, from, to } }, { batch: !!o.lean, synonyms: !!o.synonyms, slots: !!o.slots })
    const follow = followUpTool(o.store, viewer, now, { writtenIn: 'night-review' }, { ...(o.followUp ?? {}), batch: !!o.lean })
    const tools: Tool[] = [keep, diaryTool, recallMemory, recallDiary, follow] as Tool[]
    // 开关 T：每段开头判一次门控（这一晚已经写过一版就不再判）；为真才有材料那一段和 person_card
    const gate = o.card && report.cardVersion === undefined ? o.store.cardGate(viewer(), now(), o.since) : undefined
    const card = gate?.due ? cardSection(who.name, gate) : undefined
    if (card) tools.push(personCardTool(o.store, viewer, now, () => gate!.recent.map((r) => r.id)) as Tool)
    const byName = new Map(tools.map((t) => [t.name, t]))
    // 永远带 viewer：回顾主人那段时，别人那段记下的条目也不该摆在眼前
    const kept = o.store.keptSince(o.since, 30, o.legacyDiary && !o.person ? undefined : viewer()).map((m) => m.content)
    const diaryAll = loadDiaryFor(o.lifeDir, o.books, scope)
      .filter((e) => e.date === o.day)
      .map((e) => `【${o.books.label(e.book)} ${e.time}】\n${[...e.text].slice(0, 1500).join('')}`)
    // 开关 N：材料各项都有上限（日记最多最近 4 篇、惦记清单最多 8 件），夜间成本才有封顶
    const diary = o.lean ? diaryAll.slice(-4) : diaryAll
    // 开关 W 的 N4：只列今天动过的
    const follows = followUpList(o.store, viewer(), now(), o.followUp?.weight ? { touchedBy: chunk.filter((l) => l.who === 'person').map((l) => l.text).join('\n') } : {})
    // N2：代码先把“可能和今天有关的旧记忆”带进来（只读，不算想起）
    const related = o.lean
      ? relatedLines(o.store.relatedFor(chunk.filter((l) => l.who === 'person').map((l) => l.text).join('\n'), viewer(), now()), now())
      : undefined
    // 开关 Y：今天（含这一晚前几段）失效过的键与级联候选（只读）
    const cascade = o.slots ? cascadeSection(o.store.slotChangesSince(o.since, viewer(), now())) : undefined
    const messages: ReviewMsg[] = [{ role: 'user', content: reviewPrompt({ ownerName: who.name, day: o.day, lines: chunk, part: i + 1, parts: chunks.length, kept, diary, followUps: o.lean ? follows.slice(0, 8) : follows, ...(o.style ? { style: o.style } : {}), ...(related ? { related, lean: true } : {}), ...(cascade ? { cascade } : {}), ...(card ? { card } : {}) }) }]
    try {
      let finished = false
      for (let step = 0; step < (o.maxSteps ?? (o.lean ? 6 : 12)); step++) {
        const r = await o.model.complete({ system, messages, tools: tools.map(toSchema) })
        report.spent += estimateCost(r.usage, prices)
        messages.push({ role: 'assistant', content: r.content })
        const uses = r.content.filter((b): b is Extract<ReviewBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        if (uses.length === 0) {
          report.replyChars.push(r.content.filter((b) => b.type === 'text').reduce((n, b) => n + [...(b as { text: string }).text].length, 0))
          finished = true
          break
        }
        const results: ReviewBlock[] = []
        for (const u of uses) {
          const t = byName.get(u.name)
          const out = u.name === 'person_card' && report.cardVersion !== undefined
            ? { ok: false, message: `没写上：今晚已经写过一版了（第 ${report.cardVersion} 版）` }
            : t ? ((await t.execute(u.input)) as { ok?: boolean; message: string }) : { ok: false, message: `没有这个工具：${u.name}` }
          if (out.ok !== false && u.name === 'person_card') report.cardVersion = o.store.personCard(viewer())?.version ?? 0
          if (out.ok !== false && u.name === 'keep_memory') { const ids = (out as unknown as { ids?: unknown }).ids; report.kept += Array.isArray(ids) ? ids.length : 1 }
          if (out.ok !== false && u.name === 'write_diary') report.diary++
          results.push({ type: 'tool_result', tool_use_id: u.id, content: out.message })
        }
        messages.push({ role: 'user', content: results })
        if (report.spent >= o.budget) break
      }
      if (!finished) {
        report.status = 'incomplete'
        report.reason = report.spent >= o.budget ? `到了自限 ¥${o.budget}` : '步数用完了'
        break
      }
    } catch (e) {
      report.status = 'incomplete'
      report.reason = e instanceof Error ? e.message.slice(0, 120) : '出错'
      break
    }
    // 这一段做完了：游标推进到这一段的末尾（她在这段里写下的东西已经落盘）
    o.store.setReviewCursor(o.sessionId, to, now())
    report.cursorTo = to
    report.partsDone++
    say(`第 ${i + 1}/${chunks.length} 段做完：累计记下 ${report.kept} 条、日记 ${report.diary} 篇、约 ¥${report.spent.toFixed(4)}`)
  }
  if (report.status === 'done') {
    o.store.setReviewCursor(o.sessionId, end, now())
    report.cursorTo = end
  }
  return report
}

/** 回顾的是哪一天：北京时间 06:00 之前算前一天（夜里 00:40 回顾的是刚过去的那一天） */
export function reviewDay(now: Date): { day: string; since: Date } {
  const bj = new Date(now.getTime() + 8 * 3600e3)
  if (bj.getUTCHours() < 6) bj.setUTCDate(bj.getUTCDate() - 1)
  const day = bj.toISOString().slice(0, 10)
  return { day, since: new Date(Date.parse(`${day}T00:00:00+08:00`)) }
}

/** 北京时间 HH:MM 是否在 [start, end) 里（支持跨零点）。正式运行只在夜间时段里做，避免花白天额度 */
export function inWindow(now: Date, w: { start: string; end: string }): boolean {
  const t = new Date(now.getTime() + 8 * 3600e3).toISOString().slice(11, 16)
  return w.start <= w.end ? t >= w.start && t < w.end : t >= w.start || t < w.end
}
