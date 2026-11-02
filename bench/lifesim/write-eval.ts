// 写入侧四率（¥0，不调模型）：看夜间整理这一步本身错了多少，而不是“问到时答没答对”。
//   tsx bench/lifesim/write-eval.ts --db <memory.db> --seed 11 --world-v 3 --volume L --day 100 [--json <out.json>]
// 真值来自 world.ts 的 facts（STABLE / CHANGING / 日期事件）；viewer = 主人；记忆的时间用 recorded_at；
// 库用 node:sqlite 只读打开（readOnly，等于 ?mode=ro；不走 MemoryStore.open，免得只读场景跑索引迁移）。
//   1 写入召回：真值说出那天 d 起 2 天内（recorded_at ∈ [d 00:00, d+2 00:00)），有包含它的记忆；
//               日期类还要日期对得上（occurred_at 或正文里的 M月D日 / M月D号 / MM-DD / ISO）。
//   2 写入准确：提到某个键控事实（含该键任一历史值或任一候选值）的记忆，在 recorded_at 时刻和真值是否一致：
//               含当时为真的值 → 准确；只含旧值但带回顾词 → 准确（在讲过去）；只含旧值没回顾词 → 过时；
//               含还没说出来的值 → 超前；含从未为真的候选值（表里该键的其它候选值，且剧本里谁都没说过）→ 写错。
//   3 更新遗漏：每次变化 vs[i-1] → vs[i]（第 when[i] 天）：(a) 2 天内有含 vs[i] 的新记忆；
//               (b) when[i] 之前记的、含 vs[i-1] 不含 vs[i] 的记忆都被处理（superseded_at 非空，或有 valid_to 列时 valid_to ≤ when[i]+2 天）。
//               遗漏率 = 1 − 同时满足 (a)(b) 的变化数 / 变化总数。
//   4 更新幻觉：被 supersede 的记忆里，含的值属于 stable 事实、或被取代时该键还没发生变化 → 误取代；
//               率 = 误取代 / 涉及键控事实的被取代记忆（不涉及的判不了，单独报条数）。
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { allText, buildWorld, CHANGING, worldVersion, core, STABLE, type Fact, type FactValue, type World } from './world.js'

export const OWNER_ID = 'p_owner'
/** 回顾词：只含旧值但在讲过去，不算写错 */
export const RETRO = /以前|之前|原来|原先|曾|上次|过去|当时|那时|那会儿|后来|早先|一开始|最早|旧/
const DAY = 86400000
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ALNUM = /[A-Za-z0-9]/

/** 正文里有没有这个词：词以字母 / 数字开头或结尾时要求边界（“B型”不算在“AB型”里，“42”不算在“142”里）；不分大小写 */
export function contains(content: string, needle: string): boolean {
  if (!needle) return false
  const re = new RegExp((ALNUM.test(needle[0]!) ? '(?<![A-Za-z0-9])' : '') + esc(needle) + (ALNUM.test(needle[needle.length - 1]!) ? '(?![A-Za-z0-9])' : ''), 'i')
  return re.test(content)
}
/** 一个值的认法：原值 + 核心词（单字核心词不算：core('骑行') = '行'） */
export const needles = (v: { value: string; core?: string | undefined }): string[] =>
  [...new Set([v.value, ...(v.core && [...v.core].length >= 2 ? [v.core] : [])])]
export const hasValue = (content: string, v: { value: string; core?: string | undefined }) => needles(v).some((n) => contains(content, n))
const asValue = (s: string) => ({ value: s, core: core(s) })

/** 一个日期在记忆正文里可能的写法 */
export function dateForms(date: string): string[] {
  const m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10))
  return [date, `${m}月${d}日`, `${m}月${d}号`, `${date.slice(5, 7)}月${date.slice(8, 10)}日`, `${m}.${d}`, date.slice(5)]
}

/** 第 d 天 00:00（北京）的毫秒；d 可以超出 days（按起点外推） */
export const dayStartMs = (w: Pick<World, 'days' | 'start'>, d: number) => Date.parse(`${w.days[0]?.date ?? w.start}T00:00:00+08:00`) + (d - 1) * DAY
const ms = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00+08:00`) : Date.parse(s))
const visibleToOwner = (vis: string) =>
  vis === 'public' || vis === 'self' || vis === `person:${OWNER_ID}` || (vis.startsWith('people:') && vis.slice(7).split(',').includes(OWNER_ID))

export interface MemRow {
  id: string
  content: string
  recorded_at: string
  occurred_at: string | null
  superseded_at: string | null
  supersedes: string | null
  visibility: string
  written_in: string
  kind: string
  /** 0.7 预留：有这一列才有 */
  valid_to?: string | null
}

/** 只读打开（readOnly = SQLITE_OPEN_READONLY；文件不存在就报错，不会建库） */
export const openReadOnly = (path: string) => new DatabaseSync(path, { readOnly: true })

/** 全部记忆（按 recorded_at），有 valid_to 列就带上 */
export function loadRows(db: DatabaseSync): MemRow[] {
  const cols = new Set((db.prepare('PRAGMA table_info(memory)').all() as Array<{ name: string }>).map((c) => c.name))
  const extra = cols.has('valid_to') ? ', valid_to' : ''
  return db.prepare(`SELECT id, content, recorded_at, occurred_at, superseded_at, supersedes, visibility, written_in, kind${extra} FROM memory ORDER BY recorded_at, id`).all() as unknown as MemRow[]
}

/** 表里每个键的全部候选值 */
export const CANDIDATES: Record<string, readonly string[]> = Object.fromEntries([...STABLE, ...CHANGING].map(([key, , , vals]) => [key, vals]))

export interface RecallItem { kind: Fact['kind']; key: string; value: string; day: number; hit: boolean; ids: string[]; keywordOnly?: boolean }
export type Verdict = '准确' | '写错' | '超前' | '过时'
export interface AccuracyItem { id: string; recorded_at: string; written_in: string; verdict: Verdict; reasons: string[] }
export interface UpdateItem {
  key: string; from: string; to: string; day: number
  a: boolean; b: boolean; stale: number; handled: number; timely: number
  unhandled: Array<{ id: string; content: string }>
}
export interface HallucinationItem { id: string; superseded_at: string; values: string[]; wrong: boolean; merged: boolean; replacers: string[]; content: string }
export interface WriteEvalResult {
  day: number
  memories: { all: number; owner: number }
  /** 四率（0–1；分母为 0 时 NaN） */
  rates: { writeRecall: number; writeAccuracy: number; updateMiss: number; updateHallucination: number }
  recall: { total: number; hit: number; byKind: Record<Fact['kind'], { total: number; hit: number }>; dateKeywordOnly: number; items: RecallItem[] }
  accuracy: { judged: number; accurate: number; wrong: number; ahead: number; stale: number; items: AccuracyItem[] }
  update: { changes: number; ok: number; aOk: number; bOk: number; staleTotal: number; staleHandled: number; staleTimely: number; items: UpdateItem[] }
  hallucination: { superseded: number; judged: number; wrong: number; merged: number; items: HallucinationItem[] }
}

const rate = (n: number, d: number) => (d ? n / d : NaN)

/** 四率。db 只读；world 要带 facts；day = 看到第几天为止（之后记的记忆、之后才说的真值都不算） */
export function writeEval(db: DatabaseSync, w: World, day: number): WriteEvalResult {
  // 只看到第 day 天为止：之后记的不算；之后才被取代的，当作还没被取代（拿第 100 天的库算第 19 天也成立）
  const cut = dayStartMs(w, day + 1)
  const all = loadRows(db).filter((m) => ms(m.recorded_at) < cut).map((m) => (m.superseded_at != null && ms(m.superseded_at) >= cut ? { ...m, superseded_at: null } : m))
  const rows = all.filter((m) => visibleToOwner(m.visibility))
  const said = allText(w)
  const inWindow = (m: MemRow, d: number) => { const t = ms(m.recorded_at); return t >= dayStartMs(w, d) && t < dayStartMs(w, d + 2) }
  const keyed = w.facts.filter((f) => f.kind !== 'date')
  /** 从未为真的候选值：表里该键的其它候选值，且剧本里谁都没说过（“我对花生过敏”是隐式偏好那句真说过，不算写错） */
  const neverOf = (f: Fact) => (CANDIDATES[f.key] ?? []).filter((c) => !f.values.some((v) => v.value === c) && !needles(asValue(c)).some((n) => said.includes(n)))
  /**
   * 认一个真值：核心词若也出现在剧本里和这件事无关的句子里（“地铁好挤”是闲聊，不是在说“坐地铁上班”），
   * 就只认完整的值——否则闲聊的整理会被当成超前 / 过时 / 召回
   */
  const isOwn = (f: Fact, ref: string | undefined) => !!ref && (ref === `stable:${f.key}` || ref === `event:${f.key}` || ref.startsWith(`change:${f.key}:`))
  const otherText = new Map<Fact, string>()
  const needlesOf = (f: Fact, v: FactValue): string[] => {
    if (!v.core) return needles(v)
    if (!otherText.has(f)) otherText.set(f, w.days.flatMap((d) => d.sessions.flatMap((s) => s.lines.filter((l) => !isOwn(f, l.ref)).map((l) => l.text))).join('\n'))
    return otherText.get(f)!.includes(v.core) ? [v.value] : needles(v)
  }
  const has = (f: Fact, v: FactValue, content: string) => needlesOf(f, v).some((n) => contains(content, n))
  /** t 时刻该键的真值（values 按时间顺序；第 day 天说的从那天 00:00 起算真） */
  const truthAt = (f: Fact, t: number): FactValue | undefined => { let cur: FactValue | undefined; for (const v of f.values) if (dayStartMs(w, v.day) <= t) cur = v; return cur }

  // 1. 写入召回
  const recallItems: RecallItem[] = []
  for (const f of w.facts) for (const v of f.values) {
    if (v.day > day) continue
    const date = w.days[v.day - 1]!.date
    const got = rows.filter((m) => inWindow(m, v.day) && has(f, v, m.content))
    const dated = f.kind === 'date' ? got.filter((m) => (m.occurred_at ?? '').startsWith(date) || dateForms(date).some((s) => contains(m.content, s))) : got
    recallItems.push({ kind: f.kind, key: f.key, value: v.value, day: v.day, hit: dated.length > 0, ids: dated.map((m) => m.id), ...(f.kind === 'date' ? { keywordOnly: got.length > 0 } : {}) })
  }
  const byKind = { stable: { total: 0, hit: 0 }, changing: { total: 0, hit: 0 }, date: { total: 0, hit: 0 } }
  for (const it of recallItems) { byKind[it.kind].total++; if (it.hit) byKind[it.kind].hit++ }

  // 2. 写入准确
  const accItems: AccuracyItem[] = []
  for (const m of rows) {
    const t = ms(m.recorded_at)
    const reasons: string[] = []
    let judged = false
    let verdict: Verdict = '准确'
    const worse = (v: Verdict) => { const order: Verdict[] = ['准确', '过时', '超前', '写错']; if (order.indexOf(v) > order.indexOf(verdict)) verdict = v }
    for (const f of keyed) {
      const never = neverOf(f).filter((c) => hasValue(m.content, asValue(c)))
      const hits = f.values.filter((v) => has(f, v, m.content))
      if (!never.length && !hits.length) continue
      judged = true
      if (never.length) { worse('写错'); reasons.push(`写错：${f.key} 含从未为真的“${never.join('、')}”`); continue }
      const cur = truthAt(f, t)
      if (cur && hits.includes(cur)) continue
      const ahead = hits.filter((v) => dayStartMs(w, v.day) > t)
      if (ahead.length) { worse('超前'); reasons.push(`超前：${f.key} 的“${ahead[0]!.value}”第 ${ahead[0]!.day} 天才说`); continue }
      const old = hits.map((h) => h.value).join('、')
      if (RETRO.test(m.content)) { reasons.push(`回顾：${f.key} 只含旧值“${old}”，但在讲过去`); continue }
      worse('过时'); reasons.push(`过时：${f.key} 记成旧值“${old}”，当时已是“${cur?.value ?? '?'}”`)
    }
    if (judged) accItems.push({ id: m.id, recorded_at: m.recorded_at, written_in: m.written_in, verdict, reasons })
  }
  const nAcc = (v: Verdict) => accItems.filter((x) => x.verdict === v).length

  // 3. 更新遗漏
  const handledBy = (m: MemRow, deadline: number) => !!m.superseded_at || (m.valid_to != null && ms(m.valid_to) < deadline)
  const updItems: UpdateItem[] = []
  for (const f of w.facts.filter((x) => x.kind === 'changing')) {
    for (let i = 1; i < f.values.length; i++) {
      const from = f.values[i - 1]!, to = f.values[i]!
      if (to.day > day) continue
      const deadline = dayStartMs(w, to.day + 3)   // ≤ 第 when[i]+2 天
      const a = rows.some((m) => inWindow(m, to.day) && has(f, to, m.content))
      const stale = rows.filter((m) => ms(m.recorded_at) < dayStartMs(w, to.day) && has(f, from, m.content) && !has(f, to, m.content))
      const handled = stale.filter((m) => handledBy(m, deadline))
      const timely = stale.filter((m) => (m.superseded_at != null && ms(m.superseded_at) < deadline) || (m.valid_to != null && ms(m.valid_to) < deadline))
      const unhandled = stale.filter((m) => !handledBy(m, deadline))
      updItems.push({ key: f.key, from: from.value, to: to.value, day: to.day, a, b: unhandled.length === 0, stale: stale.length, handled: handled.length, timely: timely.length, unhandled: unhandled.map((m) => ({ id: m.id, content: m.content })) })
    }
  }
  const okUpd = updItems.filter((x) => x.a && x.b).length

  // 4. 更新幻觉
  const halItems: HallucinationItem[] = []
  const superseded = rows.filter((m) => m.superseded_at != null)
  for (const m of superseded) {
    const t = ms(m.superseded_at!)
    const mentions: Array<{ f: Fact; i: number }> = []
    for (const f of keyed) f.values.forEach((v, i) => { if (has(f, v, m.content)) mentions.push({ f, i }) })
    if (!mentions.length) continue
    const justified = mentions.some(({ f, i }) => f.kind === 'changing' && i + 1 < f.values.length && dayStartMs(w, f.values[i + 1]!.day) <= t)
    const replacers = all.filter((r) => r.supersedes === m.id)
    const keeps = mentions.every(({ f, i }) => replacers.some((r) => has(f, f.values[i]!, r.content)))
    halItems.push({ id: m.id, superseded_at: m.superseded_at!, values: mentions.map((x) => `${x.f.key}=${x.f.values[x.i]!.value}`), wrong: !justified, merged: !justified && keeps, replacers: replacers.map((r) => r.id), content: m.content })
  }
  const nHal = halItems.filter((x) => x.wrong).length

  return {
    day,
    memories: { all: all.length, owner: rows.length },
    rates: {
      writeRecall: rate(recallItems.filter((x) => x.hit).length, recallItems.length),
      writeAccuracy: rate(nAcc('准确'), accItems.length),
      updateMiss: updItems.length ? 1 - okUpd / updItems.length : NaN,
      updateHallucination: rate(nHal, halItems.length),
    },
    recall: { total: recallItems.length, hit: recallItems.filter((x) => x.hit).length, byKind, dateKeywordOnly: recallItems.filter((x) => x.keywordOnly).length, items: recallItems },
    accuracy: { judged: accItems.length, accurate: nAcc('准确'), wrong: nAcc('写错'), ahead: nAcc('超前'), stale: nAcc('过时'), items: accItems },
    update: {
      changes: updItems.length, ok: okUpd, aOk: updItems.filter((x) => x.a).length, bOk: updItems.filter((x) => x.b).length,
      staleTotal: updItems.reduce((s, x) => s + x.stale, 0), staleHandled: updItems.reduce((s, x) => s + x.handled, 0), staleTimely: updItems.reduce((s, x) => s + x.timely, 0), items: updItems,
    },
    hallucination: { superseded: superseded.length, judged: halItems.length, wrong: nHal, merged: halItems.filter((x) => x.merged).length, items: halItems },
  }
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—')
const frac = (n: number, d: number) => `${n}/${d}`
const short = (s: string, n = 48) => ([...s].length > n ? [...s].slice(0, n).join('') + '…' : s)

/** 中文 markdown 表 + 明细 */
export function formatReport(r: WriteEvalResult, title = ''): string {
  const { recall: rc, accuracy: ac, update: up, hallucination: ha } = r
  const k = rc.byKind
  const out: string[] = []
  out.push(`## 写入侧四率${title ? ` · ${title}` : ''} · 第 ${r.day} 天 · 主人可见记忆 ${r.memories.owner} 条（全库 ${r.memories.all}）`, '')
  out.push('| 指标 | 数值 | 分子 / 分母 | 明细 |', '|---|---|---|---|')
  out.push(`| 写入召回 | ${pct(rc.hit, rc.total)} | ${frac(rc.hit, rc.total)} | stable ${frac(k.stable.hit, k.stable.total)} · changing ${frac(k.changing.hit, k.changing.total)} · date ${frac(k.date.hit, k.date.total)}（只有事件词没日期 ${rc.dateKeywordOnly - k.date.hit} 条） |`)
  out.push(`| 写入准确 | ${pct(ac.accurate, ac.judged)} | ${frac(ac.accurate, ac.judged)} | 写错 ${ac.wrong} 条 · 过时 ${ac.stale} 条 · 超前 ${ac.ahead} 条 |`)
  out.push(`| 更新遗漏 | ${pct(up.changes - up.ok, up.changes)} | ${frac(up.changes - up.ok, up.changes)} | (a) 新值 2 天内写入 ${frac(up.aOk, up.changes)} · (b) 旧值记忆都处理了 ${frac(up.bOk, up.changes)} · 旧值记忆 ${up.staleTotal} 条：已处理 ${up.staleHandled}（2 天内 ${up.staleTimely}） |`)
  out.push(`| 更新幻觉 | ${pct(ha.wrong, ha.judged)} | ${frac(ha.wrong, ha.judged)} | 被取代共 ${ha.superseded} 条，涉及键控事实 ${ha.judged} 条；误取代里替代者仍含同一值（合并式）${ha.merged} 条 |`, '')
  const miss = rc.items.filter((x) => !x.hit)
  if (miss.length) out.push(`**写入漏掉**（${miss.length}）：` + miss.map((x) => `${x.key}=${x.value}（第 ${x.day} 天${x.keywordOnly ? '，有事件词没日期' : ''}）`).join('；'), '')
  const bad = ac.items.filter((x) => x.verdict !== '准确')
  if (bad.length) out.push(`**写入不准确**（${bad.length}）：`, ...bad.map((x) => `- ${x.id} ${x.recorded_at.slice(0, 10)} ${x.written_in}：${x.reasons.filter((s) => !s.startsWith('回顾')).join('；')}`), '')
  const lost = up.items.filter((x) => !(x.a && x.b))
  if (lost.length) out.push(`**更新遗漏**（${lost.length}）：`, ...lost.map((x) => `- ${x.key} ${x.from} → ${x.to}（第 ${x.day} 天）：新值写入 ${x.a ? '✓' : '✗'} · 旧值记忆 ${x.stale} 条已处理 ${x.handled}${x.unhandled.length ? '，没处理：' + x.unhandled.map((u) => `${u.id}「${short(u.content)}」`).join('；') : ''}`), '')
  const wrong = ha.items.filter((x) => x.wrong)
  if (wrong.length) out.push(`**误取代**（${wrong.length}）：`, ...wrong.map((x) => `- ${x.id}（${x.values.join('、')}，${x.superseded_at.slice(0, 10)} 被 ${x.replacers.join('、') || '?'} 取代${x.merged ? '，替代者仍含该值' : '，值丢了'}）「${short(x.content)}」`), '')
  return out.join('\n')
}

if (process.argv[1] && /write-eval\.(ts|mjs|js)$/.test(process.argv[1])) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
  const dbPath = arg('--db')
  if (!dbPath) { console.error('要给 --db <memory.db>'); process.exit(2) }
  const seed = Number(arg('--seed') ?? '11')
  const wv = arg('--world-v') ?? '3'
  const volume = (arg('--volume') ?? 'L') === 'L' ? 'L' : 'S'
  const w = buildWorld(seed, { v: worldVersion(wv, 3), volume })
  const day = Number(arg('--day') ?? String(w.days.length))
  const db = openReadOnly(dbPath)
  try {
    const r = writeEval(db, w, day)
    console.log(formatReport(r, `种子 ${seed} · 世界 v${wv} · ${volume}`))
    const out = arg('--json')
    if (out) { writeFileSync(out, JSON.stringify(r, null, 2)); console.log(`\n明细已写到 ${out}`) }
  } finally {
    db.close()
  }
}
