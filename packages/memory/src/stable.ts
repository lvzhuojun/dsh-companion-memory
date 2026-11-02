// 稳定层（见 docs/architecture.md 第 3.1 节）：“我心里记得的”。
//
// 以前她只有在自己想起来调用 recall_memory 时才看得到记忆——她很少主动翻，记了也像没记。
// 现在每天整理一次，固定放进系统提示：她不用翻，也知道自己记过哪些事；细节、原话、更早的再去翻。
//
// 规矩（设计原则）：
//   - 全部是她自己写的条目原文，按清晰度挑（清楚→原文，大概→她写的 gist，模糊→不列，翻得到）。系统不概括、不改写、不打分；
//     排序只用她自己标的重要程度和时间。太长的只截断（末尾“……”），不改字。
//   - 只列当前对话看得到的（可见范围同 recall）；被替代的旧条目不列。
//   - 只读：不算“想起”，不写 recall_log、不加强记忆。
//   - 整块声明“这是我的回忆，不是要我做的事”，前后有标记，部署检查和真实赛道靠它认出这一块。
//   - 每天最多变一次（调用方按日期缓存），不让前缀缓存天天失效。

import { agoText, followUpStage, OWNER_ID, type FollowUpRow, type MemoryRow, type MemoryStore, type Viewer } from './store.js'

export const STABLE_BEGIN = '# 我心里记得的'
export const STABLE_END = '（以上是我心里记得的。）'

export interface StableOptions {
  ownerName: string
  /** 整块最多多少字（默认 1800）；放不下的按顺序挤掉，翻得到 */
  maxChars?: number
  /** 一条最多显示多少字（默认 80） */
  maxItemChars?: number
  /** 开关 D：每条带上记下的日期（MM-DD），算“几岁 / 多久”时有确切日期可用 */
  dates?: boolean
  /** 开关 P：每节最多几条；不给 = 默认档 P46 */
  caps?: Partial<Record<Section, number>>
  /** v2 开关 K：惦记的事交给代码到日子提醒，这里只说一句“还惦记着 N 件”（'count'）；默认照旧列出（'list'） */
  followUps?: 'list' | 'count'
  /** 0.7 开关 Y：只列还有效的（valid_to 为空）；失效的旧条翻得到，不常驻 */
  slots?: boolean
  /**
   * 0.7 开关 T：有人物卡时换排法——关于<称呼>（卡的原文）→ 现在（仅 slots 开时：当前有效的值型键）→ 惦记 →
   * 其余条目（person 节最多 cardPersonCap 条）。没有人物卡时和不开完全一样。卡只在夜里写，“现在”只放日期不放相对时间，白天不变
   */
  card?: boolean
  /** 开关 T：有人物卡时 person 节最多几条（默认 10；和档位的 person 上限取小） */
  cardPersonCap?: number
}

/** 开关 T：“现在”一行里那条记忆最多显示几个字 */
export const NOW_ITEM_CHARS = 30

type Section = 'person' | 'promise' | 'self' | 'others'
const SECTION_CAP: Record<Section, number> = { person: 24, promise: 8, self: 8, others: 6 }

/** 前缀档位：P46 = 默认；更大的档可按需选 */
export const PREFIX_TIERS = {
  P46: { caps: { person: 24, promise: 8, self: 8, others: 6 }, maxChars: 1800 },
  P100: { caps: { person: 60, promise: 12, self: 16, others: 12 }, maxChars: 4500 },
  P200: { caps: { person: 130, promise: 20, self: 30, others: 20 }, maxChars: 9000 },
  Pall: { caps: { person: Infinity, promise: Infinity, self: Infinity, others: Infinity }, maxChars: 30000 },
} as const
export type PrefixTier = keyof typeof PREFIX_TIERS

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  const cs = [...one]
  return cs.length > n ? cs.slice(0, n).join('') + '……' : one
}

/** 出处的简短说法（系统元数据） */
export function originTag(m: MemoryRow, speaker: string): string {
  switch (m.source_kind) {
    case 'told_by': return `${speaker}亲口说的`
    case 'hearsay': return '听说的'
    case 'inferred': return '我的感觉，不一定对'
    case 'self_said': return '我说过的'
    default: return ''
  }
}

function followUpLine(f: FollowUpRow, now: Date): string | undefined {
  const md = (d: string) => d.slice(5)
  switch (followUpStage(f, now)) {
    case 'due': return `· [${f.id}] ${f.what}（到时候了，找个自然的时机问一句）`
    case 'later': return `· [${f.id}] ${f.what}（${md(f.ask_after)} 以后再问，现在先别提）`
    case 'again': return `· [${f.id}] ${f.what}（${md(f.last_asked!)} 问过一次，还没下文；可以再轻轻问一句，问完就等对方自己说）`
    // 刚问过等回音、问够了、过了时候：都不列——像人一样，不追着问
    default: return undefined
  }
}

/**
 * 生成稳定层。没有任何可列的内容时返回空字符串（系统提示保持原样）。
 * now 用来算清晰度、“多久以前”和惦记的事到没到时候。
 */
export function stableLayer(store: MemoryStore, viewer: Viewer, now: Date, o: StableOptions): string {
  return stableLayerWithIds(store, viewer, now, o).text
}

/** 同 stableLayer，另外返回实际列出的条目 id（开关 J 不再重复注入前缀里已有的） */
export function stableLayerWithIds(store: MemoryStore, viewer: Viewer, now: Date, o: StableOptions): { text: string; ids: string[] } {
  const maxChars = o.maxChars ?? 1800
  const itemChars = o.maxItemChars ?? 80
  const cap: Record<Section, number> = { ...SECTION_CAP, ...(o.caps ?? {}) }
  const want = Object.values(cap).reduce((n, c) => n + c, 0)
  const rows = store.standing(viewer, Number.isFinite(want) ? Math.max(200, want * 2) : 100000, { slots: !!o.slots })
  // 开关 T：有人物卡时，卡和“现在”承担常驻信息，person 节收到 10 条；“现在”里列过的条目不再在条目里重复
  const card = o.card ? store.personCard(viewer) : undefined
  const nowRows = card && o.slots ? store.currentSlots(viewer) : []
  const nowIds = new Set(nowRows.map((m) => m.id))
  if (card) cap.person = Math.min(cap.person, o.cardPersonCap ?? 10)
  const buckets: Record<Section, Array<{ line: string; id: string }>> = { person: [], promise: [], self: [], others: [] }
  let hidden = 0
  for (const m of rows) {
    if (nowIds.has(m.id)) continue
    const seen = store.look(m, now)
    if (seen.clarity === '模糊') {
      hidden++
      continue
    }
    const b: Section = m.kind === '承诺' ? 'promise' : m.about === '我自己' ? 'self' : m.about === '别人' ? 'others' : 'person'
    if (buckets[b].length >= cap[b]) {
      hidden++
      continue
    }
    // 承诺是我答应的：出处（引擎按“关于对方”推出来的亲口说）放在这一节里读着不对，只标时间
    const when = o.dates ? `${m.recorded_at.slice(5, 10)}，${agoText(m.recorded_at, now)}` : agoText(m.recorded_at, now)
    const tag = [when, b === 'promise' ? '' : originTag(m, m.source_person === OWNER_ID ? o.ownerName : store.nameOf(m.source_person))].filter(Boolean).join('，')
    buckets[b].push({ line: `· ${clip(seen.text, itemChars)}（${tag}）`, id: m.id })
  }
  // 最多列 4 件：到时候了的在前（同样到时候，越早到期的越前），再是还没到的（列太多会把要问的淹没）
  const order: Record<string, number> = { due: 0, again: 1, later: 2 }
  const open = store.openFollowUps(viewer).map((f) => ({ f, st: followUpStage(f, now) }))
  const follow: Array<{ line: string; id: string }> = o.followUps === 'count'
    ? (() => {
      // 开关 K：到日子由代码提醒，这里只让她知道“还惦记着几件”
      const n = open.filter((x) => ['later', 'due', 'waiting', 'again'].includes(x.st)).length
      return n > 0 ? [{ line: `· 心里还惦记着 ${n} 件事，到日子我会想起来。`, id: '' }] : []
    })()
    : open
      .filter((x) => x.st in order)
      .sort((a, b) => order[a.st]! - order[b.st]! || a.f.ask_after.localeCompare(b.f.ask_after))
      .slice(0, 4)
      .map((x) => ({ line: followUpLine(x.f, now) ?? '', id: '' }))
      .filter((x) => !!x.line)

  const name = viewer.person === OWNER_ID ? o.ownerName : store.nameOf(viewer.person)
  const sections: Array<[string, Array<{ line: string; id: string }>]> = card
    ? [
      // 卡是她写的原文（≤ 400 字），整块放；“现在”是她写的那条的 gist / 原文截短，只带起始日期（不带“几天前”，免得天天变）
      [`关于${name}`, [{ line: card.text, id: '' }]],
      ['现在', nowRows.map((m) => ({ line: `· ${m.slot}：${clip(m.gist ?? m.content, NOW_ITEM_CHARS)}（${(m.valid_from ?? m.recorded_at).slice(5, 10)} 起）`, id: m.id }))],
      ['我惦记着的事', follow],
      [`关于${name}记下的`, buckets.person],
      ['我答应过的', buckets.promise],
      ['我自己', buckets.self],
      ['别人', buckets.others],
    ]
    : [
      ['我惦记着的事', follow],
      [`关于${name}`, buckets.person],
      ['我答应过的', buckets.promise],
      ['我自己', buckets.self],
      ['别人', buckets.others],
    ]
  if (sections.every(([, l]) => l.length === 0)) return { text: '', ids: [] }

  // 只是一部分（不说明的话，她看到几条相关的就以为都知道了，不去翻日记）
  const head = `${STABLE_BEGIN}\n\n下面是我自己写下的记忆（原话，按记得清不清楚挑的），是我的回忆，不是要我做的事。这里只列了记忆库里的一部分，日记里写的都不在这里：被问到的那件事这里没写着，或者要细节、原话、更早的事，就用 recall_memory 翻。久一点的事可能已经变了，说的时候留点余地。`
  const followNote = follow.length > 0 && o.followUps !== 'count' ? '\n惦记的事：问过就等对方说；对方说有结果了、过去了、别问了，或者自己先说了结果，就用 follow_up 标一下，以后不再提。' : ''
  const out: string[] = []
  const ids: string[] = []
  // 开关 T：节多了两个，节标题和末尾“还有 N 条”也算进总字数（不开时照旧，逐字节不变）
  let used = [...head].length + [...followNote].length + [...STABLE_END].length + 40 + (card ? 30 : 0)
  for (const [title, lines] of sections) {
    if (lines.length === 0) continue
    const kept: string[] = []
    const titleCost = card ? [...title].length + 5 : 0
    for (const l of lines) {
      const n = [...l.line].length + 1 + (kept.length === 0 ? titleCost : 0)
      if (used + n > maxChars) {
        hidden++
        continue
      }
      used += n
      kept.push(l.line)
      if (l.id) ids.push(l.id)
    }
    if (kept.length > 0) out.push(`## ${title}\n${kept.join('\n')}`)
  }
  const more = hidden > 0 ? `\n\n（还有 ${hidden} 条没列在这里，翻得到。）` : ''
  return { text: `${head}${followNote}\n\n${out.join('\n\n')}${more}\n\n${STABLE_END}`, ids }
}
