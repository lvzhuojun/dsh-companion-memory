// 日记回读：让“写下来就不会忘”成为真话。
//
// 日记文件格式（由 write_diary 追加写入）：
//   $LIFE/diary/<给主人的本子|private>/YYYY-MM-DD.md，每篇以 “## HH:MM” 开头。
// 这里只读，不写。
//
// 两本日记：给主人看的一本 + 私人的一本。给主人那本的 id 和主人的称呼来自配置：
//   默认 to_owner / “主人”（目录 to-owner）；可以配置成别的 id 与称呼（目录名跟着 id 走，已有日记不迁移）。
//
// 设计原则：她写的东西不被改写。回读时日记整篇原样交给她——不润色、不摘要、不在中间截断；
// 一次放不下的篇只列出日期和时间，她可以再按 date + time 翻那一篇。系统只在每篇前加“哪本 · 日期 时间”这行元数据。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { relatedTerms } from './related.js'

export const PRIVATE_BOOK = 'private'
/** 日记本 id：给主人那本（可配置）或 'private' */
export type DiaryBook = string

export interface DiaryNaming {
  /** 给主人看的那本日记的 id，小写字母开头，只含小写字母、数字、下划线；目录名把下划线换成连字符 */
  ownerBook: string
  /** 主人的称呼，出现在本子名“给…的日记”里 */
  ownerName: string
}

export const DEFAULT_DIARY_NAMING: DiaryNaming = { ownerBook: 'to_owner', ownerName: '主人' }

export interface DiaryBooks {
  /** [给主人那本, 'private'] */
  readonly ids: readonly [string, string]
  readonly owner: string
  has(id: string): boolean
  /** 目录名 */
  dir(id: DiaryBook): string
  /** 给她看的本子名 */
  label(id: DiaryBook): string
}

/** 按配置得到两本日记的 id、目录名与名字。配置不合法时抛错（插件启动时就报出来，而不是写到奇怪的目录里）。 */
export function diaryBooks(naming: DiaryNaming = DEFAULT_DIARY_NAMING): DiaryBooks {
  const { ownerBook, ownerName } = naming
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(ownerBook) || ownerBook === PRIVATE_BOOK) {
    throw new Error(`ownerBook 不合法：${JSON.stringify(ownerBook)}（小写字母开头，只含小写字母、数字、下划线，且不能是 private）`)
  }
  const name = ownerName.trim()
  if (!name || name.length > 16 || /[\r\n]/.test(name)) throw new Error('ownerName 要是 1–16 个字的一行文字')
  const ids = [ownerBook, PRIVATE_BOOK] as const
  return {
    ids,
    owner: ownerBook,
    has: (id) => id === ownerBook || id === PRIVATE_BOOK,
    dir: (id) => (id === PRIVATE_BOOK ? PRIVATE_BOOK : id.replace(/_/g, '-')),
    label: (id) => (id === PRIVATE_BOOK ? '私人日记' : `给${name}的日记`),
  }
}

const DEFAULT_BOOKS = diaryBooks()

export interface DiaryEntry {
  book: DiaryBook
  date: string // YYYY-MM-DD
  time: string // HH:MM，没有标题时为空串
  text: string
}

/** 把一天的日记文件切成一篇篇。 */
export function parseDiaryFile(content: string, book: DiaryBook, date: string): DiaryEntry[] {
  const entries: DiaryEntry[] = []
  let time = ''
  let lines: string[] = []
  const flush = () => {
    const text = lines.join('\n').trim()
    if (text) entries.push({ book, date, time, text })
    lines = []
  }
  for (const line of content.split(/\r?\n/)) {
    const m = /^##\s+(\d{1,2}:\d{2})\s*$/.exec(line)
    if (m) {
      flush()
      time = m[1]!.padStart(5, '0')
    } else {
      lines.push(line)
    }
  }
  flush()
  return entries
}

const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/

/**
 * 读出生命目录下的全部日记（按日期、时间升序）。目录不存在时返回空。
 * 只读本子目录里直接放着的 YYYY-MM-DD.md，不进子目录——别人语境的私人日记在 private/@<id>/ 子目录里（见 diaryScope），
 * 所以这里读到的永远只是“主人语境”的那部分（旧插件也一样，回滚安全）。
 */
export function loadDiary(lifeDir: string, books: DiaryBooks = DEFAULT_BOOKS, only: readonly DiaryBook[] = books.ids): DiaryEntry[] {
  const all: DiaryEntry[] = []
  for (const book of only) {
    if (!books.has(book)) continue
    all.push(...readDir(join(lifeDir, 'diary', books.dir(book)), book))
  }
  return all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
}

function readDir(dir: string, book: DiaryBook): DiaryEntry[] {
  if (!existsSync(dir)) return []
  const out: DiaryEntry[] = []
  for (const name of readdirSync(dir)) {
    const m = DATE_FILE.exec(name)
    if (!m) continue
    out.push(...parseDiaryFile(readFileSync(join(dir, name), 'utf8'), book, m[1]!))
  }
  return out
}

// ---------- 按语境隔离 ----------
//
// 日记按“写的时候在和谁聊”放进不同的格，不改她的字，只改放在哪：
//   主人私聊语境：两本照旧（给主人的 + 私人的，原位置，已有日记不迁移）
//   别人私聊语境：只有私人日记，放在 private/@<person-id>/（不能写“给主人的”——那本主人直接看）
//   群聊：不写日记、不翻日记（群聊不进个人记忆，和 ChatGPT 群聊 / Meta 的做法一致）
// 所有读日记的地方都必须经过 diaryScope(viewer)：她在和谁聊，就只翻得到那个语境下写的。

export interface DiaryViewer {
  person: string
  channel: string
}

const PERSON_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface DiaryScope {
  /** 这个语境能翻的本子（主人语境两本；别人语境只有私人的；群聊没有） */
  readable: DiaryBook[]
  /** 本子 → 目录（相对 diary/） */
  dir(book: DiaryBook): string
  /** 写：给主人的那本只在主人私聊语境里能写 */
  writable(book: DiaryBook): true | string
  /** 是不是主人语境 */
  owner: boolean
}

export function diaryScope(v: DiaryViewer, books: DiaryBooks, ownerId: string): DiaryScope {
  if (v.channel !== 'private') {
    return { readable: [], dir: () => '', writable: () => '群聊里不写日记', owner: false }
  }
  if (v.person === ownerId) {
    return { readable: [...books.ids], dir: (b) => books.dir(b), writable: () => true, owner: true }
  }
  if (!PERSON_ID.test(v.person)) throw new Error(`说话人 id 不合法：${JSON.stringify(v.person)}`)
  const sub = `${PRIVATE_BOOK}/@${v.person}`
  return {
    readable: [PRIVATE_BOOK],
    dir: () => sub,
    writable: (b) => (b === PRIVATE_BOOK ? true : `${books.label(b)}只在和${books.label(b).replace(/^给|的日记$/g, '')}的对话里写；这段是和别人聊的，可以写进私人日记`),
    owner: false,
  }
}

/** 按语境读日记：主人语境 = loadDiary（原样）；别人语境 = 只读 private/@<id>/；群聊 = 空 */
export function loadDiaryFor(lifeDir: string, books: DiaryBooks, scope: DiaryScope, only?: readonly DiaryBook[]): DiaryEntry[] {
  const want = (only ?? scope.readable).filter((b) => scope.readable.includes(b))
  if (scope.owner) return loadDiary(lifeDir, books, want)
  const all: DiaryEntry[] = []
  for (const book of want) all.push(...readDir(join(lifeDir, 'diary', scope.dir(book)), book))
  return all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
}

// ---------- 检索 ----------

const CJK = /[㐀-鿿豈-﫿]/
const SPLIT = /[\s,，。.!！?？、;；:：“”"'‘’（）()【】\[\]《》<>…—\-~～]+/
// 只表示语气、指代、时间泛指的词，单独出现时不算线索
const STOP = new Set([
  '我', '你', '他', '她', '我们', '你们', '的', '了', '吗', '呢', '吧', '啊', '呀', '是', '有', '在', '和', '就',
  '那个', '这个', '什么', '怎么', '时候', '之前', '以前', '上次', '那次', '记得', '还记得', '说过', '一下', '日记',
])

/** 把查询切成线索：整词 + 中文两字切片。 */
export function queryTerms(query: string): { words: string[]; bigrams: string[]; related: string[] } {
  const words = query
    .toLowerCase()
    .split(SPLIT)
    .map((w) => w.trim())
    .filter((w) => w && !STOP.has(w))
  const bigrams = new Set<string>()
  for (const w of words) {
    const chars = [...w]
    if (chars.length < 2 || !CJK.test(w)) continue
    for (let i = 0; i + 1 < chars.length; i++) {
      const bg = chars[i]! + chars[i + 1]!
      if (!STOP.has(bg)) bigrams.add(bg)
    }
  }
  // 相关说法（问“奶茶”也找“喜茶”）：命中只算半个整词
  return { words, bigrams: [...bigrams], related: relatedTerms(words.join(' ')) }
}

/** 一篇日记对查询的匹配分；0 表示不相关。 */
export function scoreEntry(entry: DiaryEntry, terms: { words: string[]; bigrams: string[]; related?: string[] }): number {
  const text = entry.text.toLowerCase()
  const wordHits = terms.words.filter((w) => text.includes(w)).length
  const bigramHits = terms.bigrams.filter((b) => text.includes(b)).length
  const relatedHits = (terms.related ?? []).filter((w) => text.includes(w)).length
  const coverage = terms.bigrams.length > 0 ? bigramHits / terms.bigrams.length : 0
  // 命中一个整词或相关说法、或两个以上两字切片、或一半以上的切片，才算相关
  if (wordHits === 0 && relatedHits === 0 && bigramHits < 2 && coverage < 0.5) return 0
  return wordHits * 2 + relatedHits + bigramHits * 0.5 + coverage
}

/**
 * 去掉“篇篇都有”的线索：比如主人的称呼几乎每篇都有，单凭它就会把无关的几篇顶到最前面。
 * 超过一半的篇都含的整词 / 切片不算线索；全被去掉时保留原样。
 */
export function informativeTerms<T extends { words: string[]; bigrams: string[]; related?: string[] }>(terms: T, pool: DiaryEntry[]): T {
  if (pool.length < 8) return terms
  const texts = pool.map((e) => e.text.toLowerCase())
  const rare = (w: string) => texts.filter((t) => t.includes(w)).length <= pool.length / 2
  const words = terms.words.filter(rare)
  const bigrams = terms.bigrams.filter(rare)
  if (words.length + bigrams.length === 0) return terms
  return { ...terms, words, bigrams, related: (terms.related ?? []).filter(rare) }
}

// ---------- 回读 ----------

export interface RecallDiaryQuery {
  /** 某一天：YYYY-MM-DD */
  date?: string
  /** 某个月：YYYY-MM */
  month?: string
  /** 想找的事，用自然的说法即可 */
  query?: string
  /** 某一篇：HH:MM，和 date 一起用 */
  time?: string
  /** 只翻哪本；默认两本都翻 */
  book?: DiaryBook
}

export interface RecallDiaryLimits {
  /** 一次最多看几篇 */
  maxEntries: number
  /** 一次展开的正文总字数上限。第一篇总是整篇给出（单篇最长 4000 字，由 write_diary 限制），
   *  所以单次返回的正文不超过 max(maxTotalChars, 4000) 字，约 3–4k token */
  maxTotalChars: number
  recentDays: number
}

export const DEFAULT_RECALL_LIMITS: RecallDiaryLimits = {
  maxEntries: 6,
  maxTotalChars: 2400,
  recentDays: 14,
}

export interface RecallDiaryResult {
  found: boolean
  /** 交给她看的文字：日记正文原样，只加“哪本 · 日期 时间”的标题行 */
  text: string
  entries: DiaryEntry[]
}

export const NOT_FOUND_HINT =
  '如果想不起来，就老实说不太记得了，可以请对方再讲一次；不要顺着对方的说法假装记得，也不要编细节。'

/** 只用于在提示语里回显她的查询词，不用于日记正文 */
function echo(s: string, n: number): string {
  const chars = [...s]
  return chars.length <= n ? s : chars.slice(0, n).join('') + '…'
}

const stamp = (books: DiaryBooks, e: DiaryEntry) => `${books.label(e.book)} · ${e.date}${e.time ? ' ' + e.time : ''}`

/** 日记正文原样给出；放不下的篇只列“哪本 · 日期 时间”，不展开、不截断。 */
function render(entries: DiaryEntry[], limits: RecallDiaryLimits, books: DiaryBooks): string {
  const shown: DiaryEntry[] = []
  const rest: DiaryEntry[] = []
  let total = 0
  for (const e of entries) {
    const len = [...e.text].length
    if (shown.length === 0 || total + len <= limits.maxTotalChars) {
      shown.push(e)
      total += len
    } else {
      rest.push(e)
    }
  }
  const parts = shown.map((e) => `【${stamp(books, e)}】\n${e.text}`)
  if (rest.length > 0) {
    parts.push(`（还有 ${rest.length} 篇这次放不下，没有展开：${rest.map((e) => stamp(books, e)).join('；')}。要看哪篇，用 date 和 time 再翻。）`)
  }
  return parts.join('\n\n')
}

/** 列出最近写过日记的日子（不带正文），用于“不知道翻哪天”的时候。 */
function listRecent(all: DiaryEntry[], limits: RecallDiaryLimits, books: DiaryBooks): string {
  const byDate = new Map<string, Map<DiaryBook, number>>()
  for (const e of all) {
    const c = byDate.get(e.date) ?? new Map<DiaryBook, number>()
    c.set(e.book, (c.get(e.book) ?? 0) + 1)
    byDate.set(e.date, c)
  }
  const dates = [...byDate.keys()].sort().reverse().slice(0, limits.recentDays)
  return dates
    .map((d) => {
      const c = byDate.get(d)!
      const bits = books.ids.filter((b) => c.has(b)).map((b) => `${books.label(b)} ${c.get(b)} 篇`)
      return `${d}：${bits.join('，')}`
    })
    .join('\n')
}

export function recallDiary(
  lifeDir: string,
  q: RecallDiaryQuery,
  limits: RecallDiaryLimits = DEFAULT_RECALL_LIMITS,
  books: DiaryBooks = DEFAULT_BOOKS,
  /** 按语境隔离：给了就只翻这个语境能翻的（别人语境只有 private/@<id>/）；不给 = 主人语境（原样） */
  scope?: DiaryScope,
): RecallDiaryResult {
  const all = scope ? loadDiaryFor(lifeDir, books, scope, q.book ? [q.book] : undefined) : loadDiary(lifeDir, books, q.book ? [q.book] : books.ids)
  if (all.length === 0) {
    return { found: false, entries: [], text: '日记本还是空的，一篇都没有写过。' + NOT_FOUND_HINT }
  }

  if (q.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(q.date)) {
    return { found: false, entries: [], text: 'date 要写成 YYYY-MM-DD，比如 2026-10-25。' }
  }
  if (q.time !== undefined && (!q.date || !/^\d{2}:\d{2}$/.test(q.time))) {
    return { found: false, entries: [], text: 'time 要写成 HH:MM（比如 21:05），并且和 date 一起用。' }
  }
  if (q.month !== undefined && !/^\d{4}-\d{2}$/.test(q.month)) {
    return { found: false, entries: [], text: 'month 要写成 YYYY-MM，比如 2026-10。' }
  }

  let pool = all
  if (q.date) pool = pool.filter((e) => e.date === q.date && (!q.time || e.time === q.time))
  else if (q.month) pool = pool.filter((e) => e.date.startsWith(q.month + '-'))

  const query = (q.query ?? '').trim()
  if (!query && !q.date && !q.month) {
    return {
      found: true,
      entries: [],
      text: '最近写过日记的日子（要看哪天，用 date 再翻；想找某件事，用 query）：\n' + listRecent(all, limits, books),
    }
  }

  let picked: DiaryEntry[]
  if (query) {
    const terms = informativeTerms(queryTerms(query), all)
    picked = pool
      .map((e) => ({ e, s: scoreEntry(e, terms) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (b.e.date + b.e.time).localeCompare(a.e.date + a.e.time))
      .slice(0, limits.maxEntries)
      .map((x) => x.e)
  } else {
    picked = pool.slice(-limits.maxEntries)
  }

  if (picked.length === 0) {
    const where = q.date ? `${q.date} 这天` : q.month ? `${q.month} 这个月` : '日记里'
    const what = query ? `没找到和“${echo(query, 30)}”有关的内容` : '没有写过日记'
    return { found: false, entries: [], text: `${where}${what}。` + NOT_FOUND_HINT }
  }
  return { found: true, entries: picked, text: render(picked, limits, books) }
}
