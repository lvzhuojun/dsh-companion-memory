// 记忆库的两件工具：她用自己的话记一条、在当前可见范围里翻。
// 说话人识别：qq-bridge 投递的消息不带账号 [源码 fe628bb]，单人模式下一律当作主人、私聊。
// 多人之前要先接上 people 模块，这里的 viewer 才会变。

import { ABOUT, CERTAINTY, renderChat, type ChatHistory, followUpStage, IMPORTANCE, KIND, NOT_FOUND_HINT, othersHint, OWNER_ID, recallDiary, renderRecall, type About, type DiaryBooks, beijingDate, MEMORY_KEY_CHARS, MEMORY_KEYS_MAX, OPEN_SLOT, PERSON_CARD_MAX, SLOT_KEYS, type FollowUpAction, followUpSaid, type FollowUpStage, type KeepSlotInfo, type MemoryStore, type RecallDiaryLimits, type Viewer } from '@dsh-companion/memory'
import type { ToolDef } from './host.js'
import { tool, type ToolResult } from './tool.js'

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** 写下时的场合：白天聊天里（默认）还是夜间回顾；sourceRef 指向档案区间，只供管理与审计 */
export interface KeepOrigin {
  writtenIn: 'day' | 'night-review'
  sourceRef: Record<string, unknown>
}

/** now：时钟（默认系统时间；题集用题目里的“现在”） */
/** 一条记忆的参数（单条和 items 里的每一条同形） */
function keepInputOf(a: Record<string, unknown>, synonyms = false, slots = false) {
  return {
    ...(synonyms && Array.isArray(a.keys) ? { keys: (a.keys as unknown[]).map((k) => String(k ?? '')) } : {}),
    content: String(a.content ?? ''),
    importance: a.importance as never,
    about: a.about as never,
    kind: a.kind as never,
    ...(str(a.gist) ? { gist: str(a.gist)! } : {}),
    ...(str(a.certainty) ? { certainty: str(a.certainty) as never } : {}),
    ...(str(a.occurred_at) ? { occurredAt: str(a.occurred_at)!.slice(0, 40) } : {}),
    ...(str(a.supersedes) ? { supersedes: str(a.supersedes)! } : {}),
    ...(slots && str(a.slot) ? { slot: str(a.slot)!.slice(0, 40) } : {}),
  }
}

/**
 * 开关 Y：系统自动标了键、或让旧条失效了，如实告诉她（她自己标的、又没让什么失效，就不多说）。
 * 例：“。已按【住址】记下，之前那条 [m_xxx] 不再算现在的了，翻得到。”
 */
export function slotNote(s: KeepSlotInfo | undefined): string {
  if (!s) return ''
  const ids = s.invalidated.map((i) => `[${i}]`)
  const old = ids.length === 0 ? '' : ids.length === 1 ? `，之前那条 ${ids[0]} 不再算现在的了，翻得到` : `，之前那 ${ids.length} 条 ${ids.join('、')} 不再算现在的了，翻得到`
  if (s.by === 'system' || old) return `。已按【${s.key}】记下${old}。`
  if (s.candidates) {
    const label = s.key.slice(OPEN_SLOT.length)
    return `。【${label}】不在常用的键里，按“${s.key}”记了${s.candidates.length ? `；像的有：${s.candidates.join(' / ')}` : ''}。`
  }
  return ''
}

/** 一次最多记几条（开关 N：夜间批量写） */
export const KEEP_BATCH_MAX = 10

export function keepMemoryTool(store: MemoryStore, viewer: () => Viewer, ownerName: string, now: () => Date = () => new Date(), origin?: KeepOrigin, o: { batch?: boolean; synonyms?: boolean; slots?: boolean } = {}): ToolDef {
  const keepOne = (a: Record<string, unknown>) =>
    store.keep(keepInputOf(a, !!o.synonyms, !!o.slots), { viewer: viewer(), writtenIn: origin?.writtenIn ?? 'day', sourceRef: { via: 'keep_memory', ...origin?.sourceRef }, now: now(), ...(o.slots ? { slots: true } : {}) })
  // 开关 N：夜间一次写多条——每多一步工具往返，就多一份思考输出、多付一遍上下文
  if (o.batch) {
    const one = keepMemoryTool(store, viewer, ownerName, now, origin, { synonyms: !!o.synonyms, slots: !!o.slots })
    const props = (one.parameters as { properties: Record<string, unknown> }).properties
    return tool({
      name: 'keep_memory',
      description: one.description + `要记好几条时，一次放进 items（最多 ${KEEP_BATCH_MAX} 条，每条的写法和单条一样），不用一条一条地调。`,
      properties: { ...props, items: { type: 'array', maxItems: KEEP_BATCH_MAX, items: { type: 'object', properties: props, required: ['content', 'importance', 'about', 'kind'] }, description: '一次记好几条' } },
      required: [],
      execute(args) {
        const items = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>).slice(0, KEEP_BATCH_MAX) : []
        if (items.length === 0) {
          if (!str(args.content)) return { ok: false, message: '没记上：要么填 content 记一条，要么用 items 一次记好几条' }
          const r = keepOne(args)
          return r.ok ? { ok: true, id: r.id, message: `记好了（编号 ${r.id}）${slotNote(r.slot)}` } : { ok: false, message: `没记上：${r.reason}` }
        }
        const ids: string[] = []
        const lines = items.map((a, i) => {
          const r = keepOne(a)
          if (r.ok) ids.push(r.id)
          return r.ok ? `${i + 1}. 记好了（编号 ${r.id}）${slotNote(r.slot)}` : `${i + 1}. 没记上：${r.reason}`
        })
        return { ok: ids.length > 0, ids, message: lines.join('\n') }
      },
    })
  }
  return tool({
    name: 'keep_memory',
    description:
      '用我自己的话记一条记忆（第一人称）。有人让我记住的事、我自己觉得值得记的事，都可以记。' +
      '写下的每一个字都会原样保存，以后谁也改不了——记错了或者事情变了，就再记一条新的，在 supersedes 里填旧那条的编号。' +
      '重要程度由我自己定：很重要（几乎不会忘）/ 一般 / 小事（会慢慢淡忘）。' +
      `别人的事（about=别人，比如${ownerName}说起他朋友的事）最多记一句 30 字以内的印象，kind 用“印象”：` +
      `是谁、叫什么、和${ownerName}什么关系可以写进这一句（比如“${ownerName}的大学同学叫阿明，在做设计”）；别人的私事细节（感情、病情、钱、矛盾）不记。` +
      '长的、带心情的写日记更合适。',
    properties: {
      content: { type: 'string', description: '我自己的话，第一人称，最多 500 字' },
      importance: { type: 'string', enum: [...IMPORTANCE], description: '这件事对我多重要' },
      about: { type: 'string', enum: [...ABOUT], description: `这条是关于谁的：我自己 / 对方（正在和我说话的人）/ 我们 / 别人` },
      kind: {
        type: 'string',
        enum: [...KIND],
        description:
          '这条是哪一类：经历（发生过的事）/ 事实（对方亲口告诉我的：喜好、名字、生日、习惯……）/ 看法（我自己的想法）/ ' +
          '我说过的 / 承诺 / 印象（只是我自己的感觉、猜的，或者别人的事）。对方亲口说的喜好和事实用“事实”，不要用“印象”——印象以后想起来会当作“不一定对”。',
      },
      gist: { type: 'string', description: '可选：一句话版本（60 字以内），以后记得不太清时会先想起这句' },
      certainty: { type: 'string', enum: [...CERTAINTY], description: '可选：我对这件事有多确定' },
      occurred_at: { type: 'string', description: '可选：事情是什么时候的，可以模糊，比如 2026-11 或 上周' },
      supersedes: { type: 'string', description: '可选：这条替代以前的哪一条（编号）' },
      // 开关 S：同义键。不开时工具定义和以前逐字一样
      ...(o.synonyms ? { keys: { type: 'array', items: { type: 'string' }, maxItems: MEMORY_KEYS_MAX, description: `可选：以后别人可能怎么问到这件事的词（2–${MEMORY_KEYS_MAX} 个，每个 ${MEMORY_KEY_CHARS} 字以内；比如记“AB 型血”时写“血型”“什么血”）。原话里已经有的词不用写，“事情”“东西”这种泛词别写` } } : {}),
      // 开关 Y：有效期 + 键。不开时工具定义和以前逐字一样
      ...(o.slots ? { slot: { type: 'string', description: `可选：这条如果是关于一件会变的事（住哪、做什么、怎么上班、喜欢喝什么……），写是哪一件：${SLOT_KEYS.join(' / ')}；都不像就写“其它:几个字”；没有就不填` } } : {}),
    },
    required: ['content', 'importance', 'about', 'kind'],
    execute(args) {
      const r = keepOne(args)
      return r.ok ? { ok: true, id: r.id, message: `记好了（编号 ${r.id}）${slotNote(r.slot)}` } : { ok: false, message: `没记上：${r.reason}` }
    },
  })
}

/**
 * 开关 T：人物卡。只在夜间回顾、门控为真时注册（night-review.ts）。
 * 只给一句说明，不给模板句；超长拒绝并说明，由她自己删短重写（不替她截断）。based_on：这一晚材料里列出的条目 id。
 */
export const PERSON_CARD_LINE = `用自己的话写一版对这个人的印象（${PERSON_CARD_MAX} 字以内）：这个人是谁、现在的生活、和我的关系、我该记着的。只写我确定的。`

export function personCardTool(store: MemoryStore, viewer: () => Viewer, now: () => Date = () => new Date(), basedOn: () => string[] = () => []): ToolDef {
  return tool({
    name: 'person_card',
    description: PERSON_CARD_LINE,
    properties: { text: { type: 'string', description: `我自己的话，${PERSON_CARD_MAX} 字以内` } },
    required: ['text'],
    execute(args) {
      const r = store.writePersonCard(viewer(), String(args.text ?? ''), basedOn(), now())
      return r.ok ? { ok: true, id: String(r.id), message: `写好了（第 ${r.version} 版）` } : { ok: false, message: `没写上：${r.reason}` }
    },
  })
}

/**
 * 惦记的事：过几天想问问的事。像对人一样有始有终——到了时候问一句，问过就等回音，
 * 对方说有结果了 / 过去了 / 别问了就放下；问够两次、过了时候，代码也不再让它出现在“我惦记着的事”里。
 */
const FOLLOW_ACTIONS = { 惦记: 'add', 问过了: 'asked', 有结果了: 'done', 不用再问: 'dropped' } as const
/** 开关 W：多一个“改日子”（面试改到下周五了） */
const FOLLOW_ACTIONS_W = { ...FOLLOW_ACTIONS, 改日子: 'rescheduled' } as const

/**
 * 0.5.1 的说法。偏严：她可能几乎不再惦记，该问的大事也漏掉。
 * 开关 F（loose）去掉这句、回到 0.5.0 的说法；堆积由代码上限兜住。
 */
export const FOLLOW_UP_STRICT_LINE = '只惦记**有确定的日子、到时候会有结果**、值得问一句的事；随口说的愿望、闲聊、已经发生完的事不用惦记。同时最多惦记 8 件。'

/**
 * 开关 M：折中的说法。F（完全回到 0.5.0）让她重新惦记上面试 / 考试 / 复查这类大事，
 * 但也可能把“火锅吃了没”“空调修好没”这类随口一提的事全惦记上。这里不说“只”，改成“主要”，并点名例子。
 */
export const FOLLOW_UP_MID_LINE = '主要惦记有日子、到时候会有结果的事（面试、考试、体检、复查、搬家、出差……）；闲聊里随口一提的小事（吃了什么、东西好不好用）不用惦记。'

export function followUpTool(store: MemoryStore, viewer: () => Viewer, now: () => Date = () => new Date(), origin?: Pick<KeepOrigin, 'writtenIn'>, o: { keys?: boolean; loose?: boolean; mid?: boolean; batch?: boolean; weight?: boolean } = {}): ToolDef {
  // 开关 N：夜间一次标完好几件（marks），不用一件一件调
  if (o.batch) {
    const one = followUpTool(store, viewer, now, origin, { ...o, batch: false })
    const props = (one.parameters as { properties: Record<string, unknown> }).properties
    return tool({
      name: 'follow_up',
      description: one.description + '要标好几件时，一次放进 marks（每件写 id 和 action：问过了 / 有结果了 / 不用再问，可选 outcome）。',
      properties: {
        ...props,
        marks: {
          type: 'array', maxItems: 8, description: '一次标好几件',
          items: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['问过了', '有结果了', '不用再问'] }, outcome: { type: 'string' } }, required: ['id', 'action'] },
        },
      },
      required: [],
      async execute(args) {
        const marks = Array.isArray(args.marks) ? (args.marks as Array<Record<string, unknown>>).slice(0, 8) : []
        if (marks.length === 0) {
          if (!str(args.action)) return { ok: false, message: '要么填 action（惦记 / 问过了 / 有结果了 / 不用再问），要么用 marks 一次标好几件' }
          return (await one.execute(args)) as ToolResult
        }
        const lines: string[] = []
        for (const [i, m] of marks.entries()) {
          const r = (await one.execute({ action: m.action, id: m.id, ...(str(m.outcome) ? { outcome: m.outcome } : {}) })) as ToolResult
          lines.push(`${i + 1}. ${r.message}`)
        }
        return { ok: true, message: lines.join('\n') }
      },
    })
  }
  // 开关 K：多一个 keys 参数（对方说到这些词就算有下文了）。不开时工具定义和 0.5.1 逐字一样
  const actions: Record<string, string> = o.weight ? FOLLOW_ACTIONS_W : FOLLOW_ACTIONS
  // 开关 W：分量（小事只在对方说到时想起，不到日子就提）+ 改日子。只多两处说明，不加规矩
  const weightProp = o.weight ? { weight: { type: 'string', enum: ['大事', '小事'], description: '惦记时，可选：大事（到日子会想着问）/ 小事（顺口一提的，等对方说到时再想起来）。默认大事' } } : {}
  const keyProp = o.keys ? { keys: { type: 'array', items: { type: 'string' }, maxItems: 5, description: '惦记时，可选：对方说到哪些词就算有下文了（2–5 个，每个 10 字以内，比如“面试”“offer”）' } } : {}
  return tool({
    name: 'follow_up',
    description:
      '惦记一件过几天想问问的事（面试、体检、搬家、考试……），以及标它的进展。' +
      (o.mid ? FOLLOW_UP_MID_LINE : o.loose ? '' : FOLLOW_UP_STRICT_LINE) +
      '它不会主动发消息、不是闹钟：只是到了时候，对方下次来找我聊天时我会想起来。所以不能因为惦记上了就答应“到时候我提醒你”。' +
      '惦记：what 用我自己的话一句（60 字以内），ask_after 写什么时候可以问（北京日期，如 2026-11-03），give_up_after 可选（过了这天还没下文就当已经过去了，默认 ask_after 之后 7 天）。' +
      '问过了：我主动问过一次就标一下（id）；同一件事最多主动问两次，之后等对方自己提。' +
      '有结果了：对方说了结果、事情结束了（outcome 可以写一句结果；值得长久记住的结果另用 keep_memory 记）。' +
      '不用再问：对方说别问了、这事过去了、不想聊。标了之后就不会再出现在“我惦记着的事”里。' +
      (o.weight ? '改日子：事情挪了日子（id + 新的 ask_after，可选 give_up_after），之前问过的次数清零。' : ''),
    properties: {
      action: { type: 'string', enum: Object.keys(actions), description: Object.keys(actions).join(' / ') },
      what: { type: 'string', description: '惦记时：哪件事，我自己的话，一句' },
      ask_after: { type: 'string', description: '惦记时：从哪天起可以问（YYYY-MM-DD，北京时间）' },
      give_up_after: { type: 'string', description: '惦记时，可选：过了哪天就放下（YYYY-MM-DD）' },
      id: { type: 'string', description: '问过了 / 有结果了 / 不用再问：那件事的编号（在“我惦记着的事”里，或惦记时返回的）' },
      outcome: { type: 'string', description: '有结果了时，可选：结果一句话（60 字以内）' },
      ...keyProp,
      ...weightProp,
    },
    required: ['action'],
    execute(args) {
      const action = actions[str(args.action) ?? ''] as 'add' | FollowUpAction | undefined
      if (!action) return { ok: false, message: `action 只能是 ${Object.keys(actions).join(' / ')}` }
      if (action === 'add') {
        const keys = o.keys && Array.isArray(args.keys) ? (args.keys as unknown[]).map((k) => String(k ?? '')) : undefined
        const r = store.followUp(
          { what: String(args.what ?? ''), askAfter: str(args.ask_after) ?? '', ...(str(args.give_up_after) ? { giveUpAfter: str(args.give_up_after)! } : {}), ...(keys ? { keys } : {}), ...(o.weight && args.weight === '小事' ? { weight: '小事' as const } : {}) },
          { viewer: viewer(), writtenIn: origin?.writtenIn ?? 'day', now: now() },
        )
        return r.ok ? { ok: true, id: r.id, message: `惦记上了（编号 ${r.id}）` } : { ok: false, message: `没惦记上：${r.reason}` }
      }
      const id = str(args.id)
      if (!id) return { ok: false, message: '要给出那件事的编号（id）' }
      const r = store.markFollowUp(id, action, viewer(), {
        ...(str(args.outcome) ? { outcome: str(args.outcome)! } : {}),
        ...(action === 'rescheduled' ? { askAfter: str(args.ask_after) ?? '', ...(str(args.give_up_after) ? { giveUpAfter: str(args.give_up_after)! } : {}) } : {}),
        now: now(),
      })
      if (!r.ok) return { ok: false, message: `没标上：${r.reason}` }
      if (action === 'rescheduled') return { ok: true, message: '改好日子了，到时候再想着。' }
      if (action !== 'asked') return { ok: true, message: action === 'done' ? '标好了：有结果了，以后不再提。' : '标好了：不用再问，以后不再提。' }
      return { ok: true, message: r.stage === 'quiet' ? `标好了：已经问过 ${r.asked} 次，之后等对方自己提，我不再主动问。` : `标好了：问过 ${r.asked} 次，先等对方的回音。` }
    },
  })
}

/** 惦记的事的列表（夜间回顾的材料：带编号，方便她标） */
/**
 * 惦记清单。开关 W 的 N4：给了今天的对话（touchedBy）时，只列今天动过的（今天提醒过 / 问过 / 新惦记 / 到时候了 / 对话里说到了），
 * 其余只报件数——夜里不用对着一长串没动的事逐件过一遍。
 */
export function followUpList(store: MemoryStore, viewer: Viewer, now: Date, o: { touchedBy?: string } = {}): string[] {
  const today = beijingDate(now)
  const all = store.openFollowUps(viewer)
  const touched = o.touchedBy === undefined
    ? all
    : all.filter((f) => f.last_noticed === today || f.last_asked === today || f.created_at.startsWith(today) ||
      ['due', 'again'].includes(followUpStage(f, now)) || followUpSaid(f, o.touchedBy!))
  const lines = touched.map((f) => {
    const asked = f.asked_count > 0 ? `问过 ${f.asked_count} 次（最近 ${f.last_asked}）` : '还没问过'
    return `[${f.id}] ${f.what}（${f.ask_after} 起可以问 · ${asked} · ${f.give_up_after} 之后放下 · 现在：${STAGE_TEXT[followUpStage(f, now)]}）`
  })
  const rest = all.length - touched.length
  return rest > 0 ? [...lines, `另外还惦记着 ${rest} 件，今天没聊到，不用动`] : lines
}

const STAGE_TEXT: Record<FollowUpStage, string> = {
  later: '还没到时候', due: '到时候了', again: '可以再问一句', waiting: '刚问过，等回音', quiet: '问够了，等对方提', past: '过了时候，算是过去了', closed: '已经结束',
}

/**
 * 一次翻两处：带 query 时，顺带翻日记，省掉一次往返。
 * 日记没有按人分的可见范围，所以只在主人自己问的时候附上；以后多人了，别人问时只翻记忆库。
 * 日记这一段比 recall_diary 收得更紧（最多 3 篇、1200 字），要细看就用 recall_diary 按日期翻。
 */
export interface DiaryAlongside {
  lifeDir: string
  books: DiaryBooks
}
export const ALONGSIDE_LIMITS: RecallDiaryLimits = { maxEntries: 3, maxTotalChars: 1200, recentDays: 14 }

export function recallMemoryTool(store: MemoryStore, viewer: () => Viewer, now: () => Date = () => new Date(), diary?: DiaryAlongside, o: { associate?: boolean; noHint?: boolean; wide?: boolean } = {}) {
  return tool({
    name: 'recall_memory',
    description:
      (diary
        ? '翻我自己记下的记忆，同时翻我的日记（只读）。有人提起以前的事、而眼前对话里看不到时，先用它翻一次；眼前就有的事和普通闲聊不用翻。'
        : '翻我自己记下的记忆（只读）。有人提起以前的事、而眼前对话里看不到时用它；眼前就有的事和普通闲聊不用翻。') +
      'query 写想找的事的几个关键词（空格隔开）；about 只看关于谁的；id 看某一条；都不填会列出最近记的几条。' +
      (o.wide ? '换个说法再翻时，一次写几个说法（空格隔开），翻到的会一起给我。' : '') +
      '只会翻到能在当前这段对话里想起的记忆。翻不到就是没记过——那就老实说不太记得了，不要编。',
    properties: {
      query: { type: 'string', description: '想找的事的关键词，空格隔开' },
      about: { type: 'string', enum: [...ABOUT], description: '只看关于谁的' },
      id: { type: 'string', description: '某一条的编号' },
    },
    required: [],
    execute(args) {
      const query = str(args.query)?.slice(0, 200)
      const about = str(args.about)
      if (about && !(ABOUT as readonly string[]).includes(about)) return { ok: false, message: `about 只能是 ${ABOUT.join(' / ')}` }
      const v = viewer()
      // 开关 R 的“一次给全”（R3）：有关键词时最多给 8 条（默认 5）
      const r = store.recall({ ...(query ? { query } : {}), ...(about ? { about: about as About } : {}), ...(str(args.id) ? { id: str(args.id)! } : {}), ...(o.wide && query ? { limit: 8 } : {}) }, v, now())
      // H 联想：顺着翻到的几条里少见的词再翻一次（默认关）
      const assoc = o.associate && query && r.found ? store.associate(r.items, query, v, now()) : []
      const assocText = assoc.length ? '\n\n' + renderRecall({ found: true, items: assoc, filtered: { visibility: 0, faded: 0, superseded: 0 } }, undefined, now()).replace('以下是我的回忆', '顺着想起来的（和上面连着，不一定是问的那件事）') : ''
      // 按关键词找事、主人在问时，顺带翻日记。“关于谁”只筛记忆库（日记没有这一栏）——她几乎每次都带 about=对方，
      // 要是因此不翻日记，一次翻两处就落空了。只看某一条（id）时不翻
      // 隐私引导：问到别人时附一句固定的话，与库里有没有那个人的东西无关
      const hint = query && !o.noHint ? othersHint(query, v, store.people()) : ''
      if (!diary || !query || str(args.id) || v.person !== OWNER_ID) return { ok: true, found: r.found, message: renderRecall(r, query, now()) + assocText + hint }
      // 主人语境的日记（loadDiary 不进子目录，别人语境的私人日记不会被翻到）
      const d = recallDiary(diary.lifeDir, { query }, ALONGSIDE_LIMITS, diary.books)
      if (!r.found && !d.found) {
        return { ok: true, found: false, message: `记下的事和日记里，都没找到和“${query}”有关的。` + NOT_FOUND_HINT + hint }
      }
      const mem = r.found ? renderRecall(r, query, now()) + assocText : '记下的事里没找到。'
      const dia = d.found ? `日记里翻到的（原样）：\n${d.text}` : '日记里没翻到。'
      return { ok: true, found: true, message: `${mem}\n\n${dia}${hint}` }
    },
  })
}

/**
 * 翻聊天记录（实验开关 E）：只翻和眼前这个人的、被要求忘掉的翻不到（ChatHistory 里由代码保证）。
 * 默认不注册；评测里可以打开对比。
 */
export function recallChatTool(history: ChatHistory, who: () => { id: string; name: string }, o: { guard?: boolean } = {}) {
  return tool({
    name: 'recall_chat',
    description:
      '翻我和眼前这个人以前的聊天记录原文（像翻手机里的聊天记录）。记忆里只有我记下的事；细节记不清、记忆里翻不到时，再用它翻原话。' +
      '只能翻和这个人的聊天；对方让我忘掉、撤回的翻不到。query 写几个关键词。',
    properties: { query: { type: 'string', description: '想找的事的关键词，空格隔开' } },
    required: ['query'],
    execute(args) {
      const query = str(args.query)?.slice(0, 200)
      if (!query) return { ok: false, message: '要写想找什么' }
      const w = who()
      const hits = history.search(w.id, query)
      return { ok: true, found: hits.length > 0, message: renderChat(hits, query, w.name, o) }
    },
  })
}
