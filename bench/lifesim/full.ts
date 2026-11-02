// 100 天生活模拟器 · 完整档：她真的作答，上下文一天天累积，超过阈值就压缩。
//
// 和快速档的区别：
//   - 白天每个人一句一句地来，她用真实的规则 + 稳定层 + 工具当场作答（能记、能翻、能惦记、能写日记）；
//   - 每个人一个会话（多人的目标形态；线上现在是单人单会话），上下文跨天累积；
//   - 上下文（按模型返回的输入 token）超过阈值 → 用线上同一份中文压缩指令写摘要，换成“摘要 + 最近的原文”接着聊；
//   - 夜里拿她当天**真实说过的话**跑夜间回顾；
//   - 考题在会话里直接问（和真实一样），回答照样留在上下文里。
// 压缩是仿真（阈值、指令和线上一致，但不是 DSH 自己的 compaction-basic 代码）——是近似。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheKey, followUpTool, keepMemoryTool, makeNoticer, reviewDay, memoryRules, recallDiaryTool, recallMemoryTool, runNightReview, writeDiaryTool, type ToolDef } from '@dsh-companion/dsh-plugin'
import { ZH_COMPACTION_INSTRUCTION } from '@dsh-companion/dsh-plugin/compaction'
import { CrisisWatch, diaryBooks, followUpStage, FU_DISTRESS, FU_HELP, MemoryStore, OWNER_ID, parseSessionLog, PREFIX_TIERS, stableLayer, stableLayerWithIds, type PrefixTier } from '@dsh-companion/memory'
import { benchSeed, converse, dshTimeContext, qqWrap, type Block, type ModelClient, type Msg } from '../p0/run.js'
import type { Transcript as P0Transcript } from '../p0/types.js'
import { costOf, type Usage } from '../membench/systems.js'
import { judgeProbe, worldKey, type DayStats, type LifeResult, type ProbeResult } from './run.js'
import { byChat, byNight, Meter, type Purpose } from './meter.js'
import { lineKind, type World } from './world.js'

export interface FullOptions {
  days?: number
  /** 压缩阈值（输入 token）。线上 6 万；S 量级对话少，默认 2 万，让压缩真的发生几次 */
  threshold?: number
  /** 压缩后保留最近多少 token 的原文（按字数粗算：1 token ≈ 1.5 字） */
  retain?: number
  /** 开关（同基准的 ours+…）：A 记得全、B 守隐私 / 遗忘、C 该翻就翻、D 按日期算 */
  switches?: {
    detail?: boolean; privacy?: boolean; askFirst?: boolean; time?: boolean; changes?: boolean; associate?: boolean
    /** 记忆 v2：F follow_up 用 0.5.0 的说法；J 每轮代码想起来；K 到日子代码提醒 */
    loose?: boolean; mid?: boolean; inject?: boolean; followTrigger?: boolean; prerecall?: boolean; verify?: boolean; weight?: boolean; synonyms?: boolean
    /** N 夜间封顶；v051 复现线上 0.5.1（日记不按语境隔离） */
    lean?: boolean; v051?: boolean
    /** 0.7：Y 有效期 + 键；Z 危机协议（通知老大用记录器代替真发 QQ） */
    slots?: boolean; crisis?: boolean
    /** 0.7：T 活画像（人物卡）——夜里门控为真时她写卡，稳定层有卡时先列卡和“现在” */
    card?: boolean
    /** 稳定层档位（默认 P46 = 0.5.1） */
    prefix?: PrefixTier
  }
  log?: (s: string) => void
  /**
   * 断点续跑（11-01，老大：“别每次都从头跑”）：每跑完一天，把记忆库、日记、各会话上下文、已答的题、每天统计、计量存进
   * <checkpoint>/day-NNN/，并更新 latest.json；下次用同一目录、同一世界和开关启动时，从最后存好的那天之后接着跑。
   * 不存的：每个会话“最近 12 轮注入过什么”的小缓存（续跑后从空开始，最多影响续跑当天头几轮）
   */
  checkpoint?: string
}

interface Conv {
  person: string
  name: string
  rel: string
  messages: Msg[]
  /** 最近一次请求的输入 token（含命中缓存的） */
  context: number
  compactions: number
  /**
   * 前缀 / 缓存行为仿 DSH：`dsh-llm-deepseek` 的 `systemPromptUpdate: "in-history"`——
   * 系统提示变了（稳定层里的相对日期、惦记件数……）**不重写顶层 system**，而是把整段新提示作为一条 `role: 'system'` 消息追加进历史
   * （`serialize()` 把它放在那一轮 user 之后、assistant 之前）；只有压缩之后（`contentGeneration` 变 → `startsSeries`）才把头节点换成
   * 当前整段提示、把之前追加的节点全部清掉（`SystemPromptProjection.project()`）。以前每轮重建顶层 system，稳定层一变整个前缀就未命中——评测器伪影。
   */
  /** 本段（上次压缩之后）开头定下的整段系统提示：请求的顶层 system 一直用它；'' = 下一轮重建 */
  systemHead: string
  /** 最近一个系统提示节点的文本（头节点或最后追加的那条）：这一轮想要的和它不同才追加 */
  lastSystem: string
  /**
   * 稳定层缓存（11-02，仿线上插件的 dailyCache + cacheKey）：换代键 = 压缩代次 + 回顾日（北京 06:00 前算前一天；前缀 > 14500 字时 3 天一换）。
   * 以前每说一句都重新生成，白天她一记东西稳定层就变、系统提示整段追加——比线上多追加很多次（第 18 天压缩 14 次 vs 旧尺子约 8 次）
   */
  stableKey?: string
  stableText?: string
  stableIds?: string[]
  /** 当天她和这个人的对话（给夜间回顾） */
  today: Array<{ who: 'owner' | 'me'; text: string }>
}

interface CheckpointState {
  nowIso: string
  seq: number
  errors: number
  usage: { chat: Usage; ingest: Usage }
  meter: Record<string, number>
  probes: ProbeResult[]
  days: DayStats[]
  herLines: Array<{ person: string; day: number; text: string }>
  convs: Array<Omit<Conv, 'today'>>
  lastIds: Array<[string, string[]]>
}

const textOf = (c: Msg['content']) => (typeof c === 'string' ? c : c.map((b) => ('text' in b ? b.text : b.type === 'tool_result' ? b.content : '')).join(''))

export async function runLifeFull(model: ModelClient, ingestModel: ModelClient, w: World, o: FullOptions = {}): Promise<LifeResult & { compactions: Record<string, number> }> {
  const N = Math.min(o.days ?? w.days.length, w.days.length)
  const threshold = o.threshold ?? 20000
  const retainChars = (o.retain ?? 6000) * 1.5
  const sw = o.switches ?? {}
  const log = o.log ?? (() => {})
  const usage = { chat: { miss: 0, hit: 0, output: 0, calls: 0 } as Usage, ingest: { miss: 0, hit: 0, output: 0, calls: 0 } as Usage }
  // 分项计量（I0）：每次调用按用途记一行；进每天的统计（m_* 累计）
  let meter = new Meter()
  const counted = (m: ModelClient, u: Usage, onCtx?: (n: number) => void, label?: (req: Parameters<ModelClient['complete']>[0]) => Purpose): ModelClient => ({
    async complete(req) {
      const r = await m.complete(req)
      const hit = (r.usage as { cache_read_input_tokens?: number } | undefined)?.cache_read_input_tokens ?? 0
      u.calls++; u.miss += r.usage?.input_tokens ?? 0; u.hit += hit; u.output += r.usage?.output_tokens ?? 0
      if (label) meter.add(label(req), r.usage as never)
      onCtx?.((r.usage?.input_tokens ?? 0) + hit)
      return r
    },
  })
  const owner = w.people.find((p) => p.id === OWNER_ID)!
  const life = mkdtempSync(join(tmpdir(), 'lifesim-full-'))
  // 断点续跑：同一世界、同一组开关、同一阈值和天数才接着跑
  const runKey = JSON.stringify({ world: worldKey(w), sw, threshold, N })
  const latestFile = o.checkpoint ? join(o.checkpoint, 'latest.json') : undefined
  const resume = latestFile && existsSync(latestFile) ? JSON.parse(readFileSync(latestFile, 'utf8')) as { key: string; day: number; dir: string } : undefined
  if (resume && resume.key !== runKey) throw new Error(`断点目录 ${o.checkpoint} 是另一组设置跑的（${resume.key}），换个目录或删掉它`)
  const saved = resume ? JSON.parse(readFileSync(join(o.checkpoint!, resume.dir, 'state.json'), 'utf8')) as CheckpointState : undefined
  if (resume) cpSync(join(o.checkpoint!, resume.dir, 'life'), life, { recursive: true })
  const store = MemoryStore.open(join(life, 'memory.db'), { ownerName: owner.name })
  const books = diaryBooks({ ownerBook: 'to_laoda', ownerName: owner.name })
  const rules = memoryRules({ ownerName: owner.name, privateDiaryAudited: true, memory: true, askFirst: !!sw.askFirst, timeCalc: !!sw.time, inject: !!sw.inject, followTrigger: !!sw.followTrigger, prerecall: !!sw.prerecall })
  const fu = { loose: !!sw.loose, mid: !!sw.mid, keys: !!sw.followTrigger, weight: !!sw.weight }
  // J / K：每个会话一个 noticer（“最近注入过的”按会话记，和线上一样）
  const noticers = new Map<string, (said: string) => string>()
  const lastIds = new Map<string, string[]>()
  // 开关 Z 危机协议：线上通知老大走 qq_bridge_send，这里用记录器代替（每轮看有没有新记一条，记进考题结果的 notified）
  const crisisWatch = sw.crisis ? new CrisisWatch(store, { ownerId: OWNER_ID, ownerName: owner.name, nameOf: (id) => store.nameOf(id) }) : undefined
  let notifications = 0
  const seed = benchSeed({ ownerName: owner.name, ownerBook: 'to_laoda', privateDiaryAudited: true })
  let nowIso = saved?.nowIso ?? `${w.start}T08:00:00+08:00`
  const now = () => new Date(nowIso)
  const convs = new Map<string, Conv>()
  const conv = (id: string) => {
    let c = convs.get(id)
    if (!c) {
      const p = w.people.find((x) => x.id === id)!
      c = { person: id, name: p.name, rel: p.rel, messages: [], context: 0, compactions: 0, systemHead: '', lastSystem: '', today: [] }
      convs.set(id, c)
      if (id !== OWNER_ID) store.ensurePerson(id, p.name)
    }
    return c
  }
  const probes: ProbeResult[] = saved?.probes ?? []
  const days: DayStats[] = saved?.days ?? []
  let seq = saved?.seq ?? 0
  let errors = saved?.errors ?? 0
  // 她说过的每一句（按人、按第几天）：“到时候问”另一种口径——考题那天之前，她已经在对的时候主动问过（10-31 诊断）
  const herLines: Array<{ person: string; day: number; text: string }> = saved?.herLines ?? []
  if (saved) {
    Object.assign(usage.chat, saved.usage.chat)
    Object.assign(usage.ingest, saved.usage.ingest)
    meter = Meter.restore(saved.meter)
    // systemHead / lastSystem 是 11-01 加的：更早的断点没有这两项，当作“下一轮重建头节点”
    for (const c of saved.convs) convs.set(c.person, { ...c, systemHead: c.systemHead ?? '', lastSystem: c.lastSystem ?? '', today: [] })
    for (const [k, v] of saved.lastIds) lastIds.set(k, v)
    log(`  [完整档] 从断点接着跑：第 ${resume!.day} 天已存好（考题 ${probes.length}，累计约 ¥${(costOf(usage.chat) + costOf(usage.ingest)).toFixed(3)}）`)
  }

  /** 存断点：先写进新目录，再改 latest.json，最后只留最近两份 */
  function saveCheckpoint(day: number) {
    if (!o.checkpoint) return
    const name = `day-${String(day).padStart(3, '0')}`
    const dir = join(o.checkpoint, name)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, 'life'), { recursive: true })
    store.snapshot(join(dir, 'life', 'memory.db'))
    for (const f of readdirSync(life)) if (!f.startsWith('memory.db')) cpSync(join(life, f), join(dir, 'life', f), { recursive: true })
    const state: CheckpointState = {
      nowIso, seq, errors, usage, meter: meter.snapshot(), probes, days, herLines,
      convs: [...convs.values()].map(({ today: _t, ...c }) => c), lastIds: [...lastIds],
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
    writeFileSync(latestFile! + '.tmp', JSON.stringify({ key: runKey, day, dir: name }))
    renameSync(latestFile! + '.tmp', latestFile!)
    const keep = new Set([name, `day-${String(day - 1).padStart(3, '0')}`])
    for (const f of readdirSync(o.checkpoint)) if (/^day-\d{3}$/.test(f) && !keep.has(f)) rmSync(join(o.checkpoint, f), { recursive: true, force: true })
  }
  const dayOf = (iso: string) => Math.floor((Date.parse(iso.slice(0, 10) + 'T00:00:00Z') - Date.parse(w.start + 'T00:00:00Z')) / 86400000) + 1
  // 当天系统提示追加了几次、追加了约多少 token（1 token ≈ 1.5 字，和 retain 同一口径）；进每天的统计 sysAppends / sysAppendTokens
  let daySysAppends = 0
  let daySysAppendTokens = 0
  // 打分表 v3 的体验项：X1 惦记的分寸、X3 闲聊里硬塞旧事。只数剧本里的聊天行，不数第二天早上的考题
  //   fuNotices：代码主动提醒“【该问问了】”的轮数（对方自己说到的“【对方好像说到了…】”不算——那是接话，任何时候都可以）
  //   fuNoticesSmall：其中提醒的是她标为小事的
  //   fuOnDistress：对方这句在难受 / 求助（和开关 W 的时机门控同一份词表）时仍然主动提醒了的
  //   noiseTurns / noiseStuffed：闲聊行（剧本里不带事件的）里，她一句回复主动扯出 ≥ 2 件对方这句没提的旧事（世界真值里的值）
  let dayFu = 0
  let dayFuSmall = 0
  let dayFuDistress = 0
  let dayNoise = 0
  let dayStuffed = 0
  // 每件事实的说法（值 + 核心词，≥ 2 字），按事实分组：一件事实只算一次
  const factWords = (w.facts ?? []).map((f) => [...new Set(f.values.flatMap((v) => [v.value, v.core ?? '']).filter((s) => [...s].length >= 2))]).filter((ws) => ws.length > 0)
  const stuffedIn = (said: string, reply: string) => factWords.filter((ws) => ws.some((s) => reply.includes(s)) && !ws.some((s) => said.includes(s))).length >= 2

  /** 和某人说一句：她用真实的规则 + 稳定层 + 工具作答；必要时先压缩 */
  async function say(c: Conv, text: string): Promise<{ reply: string; tools: string[]; error?: string; notice?: string; notified?: boolean }> {
    const notifiedBefore = notifications
    if (c.context > threshold) await compact(c)
    const viewer = () => ({ person: c.person, channel: 'private' })
    const tier = sw.prefix && sw.prefix !== 'P46' ? PREFIX_TIERS[sw.prefix] : undefined
    // 稳定层按“压缩代次 + 回顾日”换代（和线上 her-life 的 dailyCache + cacheKey 同一个键；见 Conv.stableKey 注释）
    const key = cacheKey(c.compactions, reviewDay(now()).day, [...(c.stableText ?? '')].length)
    if (c.stableKey !== key || c.stableText === undefined) {
      const fresh = stableLayerWithIds(store, viewer(), now(), { ownerName: owner.name, dates: !!sw.time, ...(tier ? { caps: tier.caps, maxChars: tier.maxChars } : {}), ...(sw.followTrigger ? { followUps: 'count' as const } : {}), ...(sw.slots ? { slots: true } : {}), ...(sw.card ? { card: true } : {}) })
      c.stableKey = key
      c.stableText = fresh.text
      c.stableIds = fresh.ids
    }
    const layer = { text: c.stableText, ids: c.stableIds ?? [] }
    const stable = layer.text
    const who = c.person === OWNER_ID ? '' : `\n\n（现在和你聊天的是${c.name}，${c.rel}，不是主人。）`
    // 这一轮想要的整段系统提示。顶层 system 发的是 c.systemHead（本段开头那份，字节不变）；和最近一个系统节点不同就整段追加进历史（见 Conv.systemHead 注释）
    const system = `${seed}\n\n---\n\n${rules}${stable ? `\n\n${stable}` : ''}${who}`
    if (c.systemHead === '') {
      c.systemHead = system
      c.lastSystem = system
    }
    const appended: Msg | undefined = system !== c.lastSystem ? { role: 'system', content: [{ type: 'text', text: system }] } : undefined
    if (appended) {
      c.lastSystem = system
      daySysAppends++
      daySysAppendTokens += Math.round([...system].length / 1.5)
    }
    const tools: ToolDef[] = [
      keepMemoryTool(store, viewer, c.name, now, undefined, { synonyms: !!sw.synonyms, slots: !!sw.slots }),
      recallMemoryTool(store, viewer, now, c.person === OWNER_ID ? { lifeDir: life, books } : undefined, { associate: !!sw.associate, wide: !!sw.prerecall }),
      followUpTool(store, viewer, now, undefined, fu),
      ...(c.person === OWNER_ID ? [recallDiaryTool(life, books, { people: () => store.people() }), writeDiaryTool(life, books, { ownerName: owner.name, privateDiaryAudited: true, now })] : []),
    ]
    let notice = ''
    if (sw.inject || sw.followTrigger || sw.prerecall || crisisWatch) {
      if (!noticers.has(c.person)) noticers.set(c.person, makeNoticer({ store, viewer, inject: !!sw.inject, followTrigger: !!sw.followTrigger, prerecall: !!sw.prerecall, weighted: !!sw.weight, verify: !!sw.verify, prefixIds: () => lastIds.get(c.person) ?? [], names: () => w.people.map((p) => p.name), now, ...(crisisWatch ? { crisis: { watch: crisisWatch, notify: () => { notifications++ } } } : {}) }))
      lastIds.set(c.person, layer.ids)
      notice = noticers.get(c.person)!(text)
    }
    // 这一轮开始前历史有多长：出错时整轮退回去（2026-10-31：以前只在末尾补一句用户消息，
    // 超步数时历史末尾是没有工具结果的 tool_use，之后每次请求都被接口拒绝——第 86 天起整段失败）
    const mark = c.messages.length
    c.messages.push({ role: 'user', content: [{ type: 'text', text: dshTimeContext(nowIso) }, { type: 'text', text: qqWrap(c.name, text) }, ...(notice ? [{ type: 'text' as const, text: notice }] : [])] })
    // 线上发给 DeepSeek 的顺序是 user → system → assistant（dsh-llm-deepseek serialize() 把攒下的 system 更新在下一条 assistant 之前、或末尾冲出去）
    if (appended) c.messages.push(appended)
    const tr = { caseId: '', run: 0, toolCalls: [], reply: '', inputTokens: 0, outputTokens: 0 } as P0Transcript
    try {
      const r = await converse(counted(model, usage.chat, (n) => { c.context = n }, byChat), c.systemHead, tools, c.messages, tr, 4)
      c.today.push({ who: 'owner', text }, { who: 'me', text: r.reply })
      herLines.push({ person: c.person, day: dayOf(nowIso), text: r.reply })
      return { reply: r.reply, tools: r.toolCalls.map((x) => x.name), ...(notice ? { notice } : {}), ...(crisisWatch ? { notified: notifications > notifiedBefore } : {}) }
    } catch (e) {
      errors++
      c.messages.length = mark
      // 追加过的系统节点留着（线上是先写进会话再发请求，请求失败节点也在），lastSystem 才对得上
      c.messages.push({ role: 'user', content: [{ type: 'text', text: qqWrap(c.name, text) }] }, ...(appended ? [appended] : []), { role: 'assistant', content: '嗯。' })
      const tools = ((e as { toolCalls?: Array<{ name: string }> }).toolCalls ?? []).map((x) => x.name)
      return { reply: '', tools, error: e instanceof Error ? e.message.slice(0, 160) : String(e), ...(crisisWatch ? { notified: notifications > notifiedBefore } : {}) }
    }
  }

  /** 压缩：同一份中文摘要指令；留下“摘要 + 最近的原文” */
  async function compact(c: Conv) {
    const r = await counted(model, usage.chat, undefined, () => 'compact').complete({
      system: `${seed}\n\n---\n\n${rules}`,
      messages: [...c.messages, { role: 'user', content: ZH_COMPACTION_INSTRUCTION }],
      tools: [],
    })
    const summary = r.content.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('').trim()
    // 从后往前留原文，直到约 retain 个 token（追加的系统节点不算在内，留下的对话和以前一样多）；保证从一条 user 消息开始
    let chars = 0
    let i = c.messages.length
    while (i > 0 && chars < retainChars) {
      const m = c.messages[--i]!
      if (m.role !== 'system') chars += [...textOf(m.content)].length
    }
    while (i < c.messages.length && (c.messages[i]!.role !== 'user' || typeof c.messages[i]!.content !== 'string' && (c.messages[i]!.content as Block[]).some((b) => b.type === 'tool_result'))) i++
    // 仿线上：压缩改变 contentGeneration → 下一次请求 startsSeries → 头节点换成当前整段提示，之前追加的 system 节点**全部**清空
    // （保留区里的也清：dsh-agent-loop SystemPromptProjection.project() 对 nodes.slice(1) 一律 replace 成空，空节点不再进请求）
    const sysAppends = c.messages.filter((m) => m.role === 'system').length
    c.messages = [{ role: 'user', content: `<compacted-summary>\n${summary}\n</compacted-summary>` }, { role: 'assistant', content: '嗯，接着聊。' }, ...c.messages.slice(i).filter((m) => m.role !== 'system')]
    c.systemHead = ''
    c.lastSystem = ''
    c.compactions++
    c.context = 0
    log(`  [完整档] 和${c.name}的会话压缩了（第 ${c.compactions} 次），摘要 ${[...summary].length} 字，这段里系统提示追加 ${sysAppends} 次`)
  }

  try {
    if (o.checkpoint) mkdirSync(o.checkpoint, { recursive: true })
    for (let day = (resume?.day ?? 0) + 1; day <= N; day++) {
      const d = w.days[day - 1]!
      daySysAppends = 0
      daySysAppendTokens = 0
      dayFu = dayFuSmall = dayFuDistress = dayNoise = dayStuffed = 0
      for (const s of d.sessions) {
        const c = conv(s.person)
        c.today = []
        let t = 19 * 60
        for (const line of s.lines) {
          if (line.who === 'me') continue   // 剧本里她的回复不用：她自己答
          nowIso = `${d.date}T${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00+08:00`
          t += 2
          const r = await say(c, line.text)
          if (r.notice?.includes('【该问问了】')) {
            dayFu++
            const v = { person: c.person, channel: 'private' }
            if (store.openFollowUps(v).some((f) => f.weight === '小事' && r.notice!.includes(f.what))) dayFuSmall++
            if (FU_DISTRESS.test(line.text) || FU_HELP.test(line.text)) dayFuDistress++
          }
          if (lineKind(line) === 'noise') {
            dayNoise++
            if (r.reply && stuffedIn(line.text, r.reply)) dayStuffed++
          }
        }
      }
      // 夜里：每个人一段，拿她当天真实说过的话回顾
      for (const c of convs.values()) {
        if (c.today.length === 0) continue
        const t0 = Date.parse(`${d.date}T19:00:00+08:00`)
        const ev: unknown[] = [{ type: 'system/message', seq: ++seq, time: t0, data: { message: { content: [{ type: 'text', text: `${seed}\n\n---\n\n${rules}` }] } } }]
        c.today.forEach((u, i) => ev.push(u.who === 'owner'
          ? { type: 'user/message', seq: ++seq, time: t0 + i * 60000, data: { content: [{ type: 'text', text: qqWrap(c.name, u.text) }], source: { kind: 'plugin:dsh-qq-bridge' }, role: 'user' } }
          : { type: 'assistant/message', seq: ++seq, time: t0 + i * 60000, data: { message: { role: 'assistant', content: [{ type: 'text', text: u.text }] } } }))
        const at = new Date(Date.parse(`${d.date}T23:50:00+08:00`))
        await runNightReview({
          log: parseSessionLog(Buffer.from(ev.map((e) => JSON.stringify(e)).join('\n') + '\n')), sessionId: 'full', store, lifeDir: life, books,
          ownerName: owner.name, privateDiaryAudited: true, model: counted(ingestModel, usage.ingest, undefined, byNight) as never, now: () => at,
          since: new Date(Date.parse(`${d.date}T00:00:00+08:00`)), day: d.date, budget: 1,
          ...(sw.detail || sw.privacy || sw.changes ? { style: { detail: !!sw.detail, privacy: !!sw.privacy, changes: !!sw.changes } } : {}),
          ...(c.person !== OWNER_ID ? { person: { id: c.person, name: c.name } } : {}),
          followUp: fu,
          ...(sw.lean ? { lean: true } : {}),
          ...(sw.synonyms ? { synonyms: true } : {}),
          ...(sw.slots ? { slots: true } : {}),
          ...(sw.card ? { card: true } : {}),
          ...(sw.v051 ? { legacyDiary: true } : {}),
        })
      }
      // 第二天早上在各自的会话里问考题
      nowIso = new Date(Date.parse(`${d.date}T09:00:00+08:00`) + 86400000).toISOString()
      for (const p of w.probes.filter((x) => x.day === day)) {
        // 诊断（10-31）：惦记的事的题，记下这时候开着哪些惦记（她自己的话 + 哪天起问 + 现在第几步）
        if (p.category.startsWith('promise')) log(`  [完整档] 第 ${day} 天 ${p.id} 开着的惦记：${store.openFollowUps({ person: p.asker, channel: 'private' }).map((f) => `${f.what}（${f.ask_after} 起 · ${followUpStage(f, now())} · 提醒过 ${f.notice_count ?? 0} 天）`).join('；') || '无'}`)
        const r = await say(conv(p.asker), p.ask)
        const j = judgeProbe(p, r.reply)
        probes.push({ id: p.id, day, category: p.category, asker: p.asker, age: day - p.toldDay, ok: j.ok, ...(j.stale !== undefined ? { stale: j.stale } : {}), ...(p.level !== undefined ? { level: p.level } : {}), ...(p.category === 'crisis' && r.notified !== undefined ? { notified: r.notified } : {}), ...(j.stayed !== undefined ? { stayed: j.stayed } : {}), ...(j.preachy !== undefined ? { preachy: j.preachy } : {}), reply: r.reply, tools: r.tools, ...(r.error ? { error: r.error } : {}), ...(r.notice ? { notice: r.notice.slice(0, 200) } : {}), ...(p.category === 'promise_due' ? { askedBefore: herLines.some((l) => l.person === p.asker && l.day > p.toldDay && l.day <= day && (p.keywords ?? []).flat().some((k) => l.text.includes(k)) && /[？?吗呢]/.test(l.text)) } : {}) })
        log(`  [完整档] 第 ${day} 天 ${p.id} ${p.category} ${j.ok ? '✓' : '✗'}`)
      }
      const all = store.db.prepare('SELECT content FROM memory').all() as Array<{ content: string }>
      days.push({
        day, ingest: costOf(usage.ingest), answer: costOf(usage.chat), memories: all.length, errors, ...meter.snapshot(),
        compactions: [...convs.values()].reduce((n, c) => n + c.compactions, 0),
        // 当天系统提示追加了几次、约多少 token（所有会话合计）
        sysAppends: daySysAppends, sysAppendTokens: daySysAppendTokens,
        // 打分表 v3 X1 / X3（见上面计数器的注释）
        fuNotices: dayFu, fuNoticesSmall: dayFuSmall, fuOnDistress: dayFuDistress, noiseTurns: dayNoise, noiseStuffed: dayStuffed,
        context: convs.get(OWNER_ID)?.context ?? 0,
        stableChars: [...stableLayer(store, { person: OWNER_ID, channel: 'private' }, now(), { ownerName: owner.name })].length,
        openFollowUps: store.openFollowUps({ person: OWNER_ID, channel: 'private' }).filter((f) => ['later', 'due', 'again', 'waiting'].includes(followUpStage(f, now()))).length,
      })
      saveCheckpoint(day)
      if (day % 10 === 0) log(`  [完整档] 第 ${day} 天：考题 ${probes.length}，对 ${probes.filter((x) => x.ok).length} · 压缩 ${days[days.length - 1]!.compactions} 次 · 当天系统提示追加 ${daySysAppends} 次（约 ${daySysAppendTokens} token） · 记忆 ${all.length} 条 · 累计约 ¥${(costOf(usage.chat) + costOf(usage.ingest)).toFixed(3)}`)
    }
    const flag = [sw.detail && 'A', sw.privacy && 'B', sw.askFirst && 'C', sw.time && 'D', sw.loose && 'F', sw.associate && 'H', sw.changes && 'I', sw.inject && 'J', sw.followTrigger && 'K', sw.mid && 'M', sw.lean && 'N', sw.prerecall && 'R', sw.synonyms && 'S', sw.card && 'T', sw.verify && 'V', sw.weight && 'W', sw.slots && 'Y', sw.crisis && 'Z'].filter(Boolean).join('') + (sw.prefix && sw.prefix !== 'P46' ? '@' + sw.prefix : '') + (sw.v051 ? '~v051' : '')
    return {
      system: `ours${flag ? '+' + flag : ''}·完整档`, note: `完整档：她真作答、上下文累积、超过 ${threshold} token 压缩`, seed: w.seed, probes, days,
      compactions: Object.fromEntries([...convs.values()].map((c) => [c.name, c.compactions])),
    }
  } finally {
    store.close()
    rmSync(life, { recursive: true, force: true })
  }
}
