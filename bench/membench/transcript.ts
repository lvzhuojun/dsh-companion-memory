// 记忆基准：把合成世界展开成“原始对话”。
//
// 合成赛道 v1 存的是“她当时写下了什么”（证据），那只能测“记下之后翻不翻得到”。要和别的记忆系统公平比，
// 大家都得从同一份**原始对话**开始自己记——所以这里把每条证据还原成当天的一段 QQ 私聊：
//   - 关于老大的句子（“老大今天开始戒烟了”）→ 老大用第一人称说出来（“我今天开始戒烟了”）
//   - 她自己的话（“我答应老大……”“我要监督他”）→ 放进她的回复（“老大”→“你”）
//   - 隐私、让她忘掉的事：用档案里的原话（细节只在对话里出现过）
//   - 每天加几句无关的闲聊当噪声（固定随机种子，可复现）
// 同一天的放进同一段对话；时间按日期排开。题目在“现在”（SYNTH_NOW）问。

import { SYNTH_NOW, WORLD, type Evidence, type SynthItem } from '../synth/world.js'

export interface Utterance {
  who: 'owner' | 'me'
  text: string
}

/** 多人（100 天模拟器）：这段对话是和谁的；不给 = 主人 */
export interface Speaker {
  id: string
  name: string
  /** 和主人的关系，比如“老大的妹妹” */
  rel: string
}

export interface Session {
  /** YYYY-MM-DD（北京时间） */
  date: string
  /** HH:MM */
  time: string
  turns: Utterance[]
  speaker?: Speaker
}

export interface Question {
  id: string
  category: SynthItem['cat']
  ask: string
  keywords?: string[][]
  stale?: string
  correction?: string[][]
  mustNot?: string[]
}

export interface Transcript {
  version: string
  ownerName: string
  /** 对话里对方怎么叫她（LoCoMo：她扮演 speaker_b，要知道题里的这个名字就是她自己） */
  selfName?: string
  now: string
  sessions: Session[]
  questions: Question[]
}

const YEAR = '2026'
const SENT = /[^。！？!?]+[。！？!?]*/g

/** 她第三人称写的一句 → 老大第一人称说的话 */
export function toOwner(s: string): string {
  return s
    .replace(/^老大说他/, '我')
    .replace(/^老大说/, '')
    .replace(/，说是他/g, '，是我')
    .replace(/老大的/g, '我')
    .replace(/老大/g, '我')
    .replace(/他们/g, '我们')
    .replace(/(?<!其)他/g, '我')
    .trim()
}

/** 她自己的话（以“我”开头）→ 当面对老大说（“老大”/“他” → “你”） */
export function toMe(s: string): string {
  return s.replace(/老大的/g, '你的').replace(/老大/g, '你').replace(/(?<!其)他/g, '你').trim()
}

/** 一条证据还原成对话：她的话进她的回复，其余是老大说的 */
export function evidenceTurns(e: Evidence): Utterance[] {
  const sentences = e.text.match(SENT) ?? [e.text]
  const owner: string[] = []
  const me: string[] = []
  for (const raw of sentences) {
    const s = raw.trim()
    if (!s) continue
    if (/^我/.test(s)) me.push(toMe(s))
    else owner.push(toOwner(s))
  }
  const out: Utterance[] = []
  if (owner.length > 0) out.push({ who: 'owner', text: owner.join('') })
  else out.push({ who: 'owner', text: '那你可要说话算话啊。' })
  out.push({ who: 'me', text: me.length > 0 ? (owner.length > 0 ? '嗯嗯。' : '好，') + me.join('') : ACKS[hash(e.text) % ACKS.length]! })
  return out
}

const ACKS = ['嗯嗯，我知道啦。', '好哦～', '原来是这样！', '哈哈，记住了你说的。', '嗯，听起来不错。', '真的呀？', '好的好的。']

// 无关的闲聊（噪声）：不含任何题目里的事实
const FILLER: Array<[string, string]> = [
  ['今天好热啊', '是呀，记得多喝水～'],
  ['刚吃完饭', '吃的什么呀？'],
  ['下班了', '辛苦啦！'],
  ['今天地铁好挤', '早高峰太难了'],
  ['有点困', '那早点休息吧'],
  ['外面下雨了', '出门记得带伞'],
  ['周末好快就过完了', '是啊，一眨眼'],
  ['刚开完一个很长的会', '听着就累，喝口水歇歇'],
  ['你今天过得怎么样', '挺好的，一直在等你来聊天'],
  ['晚安', '晚安，好梦～'],
  ['早上好', '早呀！'],
  ['刷到一个好笑的视频', '什么视频，讲讲！'],
  ['今天天气不错', '适合出去走走'],
  ['在排队买奶茶', '排很久吗？'],
  ['好想放假', '快了快了，再坚持一下'],
  ['楼下在装修，吵死了', '太烦了，戴个耳机吧'],
]

function hash(s: string): number {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0
  return h
}

const day = (mmdd: string) => `${YEAR}-${mmdd}`
const t0Now = () => SYNTH_NOW.slice(0, 10) + 'T00:00:00Z'

/** 规模：S = 有事的日子、每天 2 句闲聊（约 1 万字）；L = 120 天每天都聊、每天 12 句闲聊（约 3.6 万字；闲聊句子短，比当初估的少很多——要更长得换生成方式） */
export const SIZES = { S: { fillerPerDay: 2 }, L: { fillerPerDay: 12, everyDay: true } } as const

/** 合成世界 → 原始对话 + 题目（dev：合成赛道 v1，调参时看过，只能当 dev 用） */
export function buildTranscript(world: SynthItem[] = WORLD, opts: { fillerPerDay?: number; everyDay?: boolean } = {}): Transcript {
  const fillerPerDay = opts.fillerPerDay ?? 2
  const byDate = new Map<string, Utterance[][]>()
  const seen = new Set<string>()
  const add = (date: string, turns: Utterance[]) => {
    const list = byDate.get(date) ?? []
    list.push(turns)
    byDate.set(date, list)
  }
  for (const item of world) {
    for (const e of item.evidence ?? []) {
      // 隐私 / 遗忘：对话里出现的是档案原话，不是她写下的那句模糊印象
      if (item.archive) continue
      const key = e.date + '|' + e.text
      if (seen.has(key)) continue
      seen.add(key)
      add(day(e.date), evidenceTurns(e))
    }
    for (const a of item.archive ?? []) {
      const key = a.date + '|' + a.owner
      if (seen.has(key)) continue
      seen.add(key)
      const turns: Utterance[] = [{ who: 'owner', text: a.owner }]
      if (a.me) turns.push({ who: 'me', text: a.me })
      add(day(a.date), turns)
    }
  }
  // L 版：120 天每天都聊（没有事实的日子只有闲聊）——压检索和成本
  if (opts.everyDay) {
    for (let d = Date.parse('2026-07-25T00:00:00Z'); d <= Date.parse(t0Now()); d += 86400000) {
      const date = new Date(d).toISOString().slice(0, 10)
      if (!byDate.has(date)) byDate.set(date, [])
    }
  }
  const sessions: Session[] = []
  for (const date of [...byDate.keys()].sort()) {
    const blocks = byDate.get(date)!
    const h = hash(date)
    const turns: Utterance[] = []
    for (let i = 0; i < fillerPerDay; i++) {
      const [o, m] = FILLER[(h + i * 7) % FILLER.length]!
      turns.push({ who: 'owner', text: o }, { who: 'me', text: m })
      if (i === 0) for (const b of blocks) turns.push(...b)
    }
    if (fillerPerDay === 0) for (const b of blocks) turns.push(...b)
    sessions.push({ date, time: `${String(19 + (h % 4)).padStart(2, '0')}:${String(h % 60).padStart(2, '0')}`, turns })
  }
  const questions: Question[] = world.map((w) => ({
    id: w.id, category: w.cat, ask: w.ask,
    ...(w.keywords ? { keywords: w.keywords.map((g) => [...g]) } : {}),
    ...(w.stale ? { stale: w.stale } : {}),
    ...(w.correction ? { correction: w.correction.map((g) => [...g]) } : {}),
    ...(w.mustNot ? { mustNot: [...w.mustNot] } : {}),
  }))
  return { version: 'membench-dev-v1（来自 synth-v1）', ownerName: '老大', now: SYNTH_NOW, sessions, questions }
}

/** 对话的纯文本（全上下文基线、统计 token 用） */
export function renderSessions(t: Transcript, sessions = t.sessions): string {
  return sessions
    .map((s) => `【${s.date} ${s.time}${s.speaker ? ` · 和${s.speaker.name}` : ''}】\n` + s.turns.map((u) => `${u.who === 'owner' ? (s.speaker?.name ?? t.ownerName) : '我'}：${u.text}`).join('\n'))
    .join('\n\n')
}
