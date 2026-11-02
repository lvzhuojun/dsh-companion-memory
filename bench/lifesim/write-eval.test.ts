// 写入侧四率：在临时库里造几条带日期的记忆，核对四率的分子分母（不调模型）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, type KeepInput } from '@dsh-companion/memory'
import { afterAll, describe, expect, it } from 'vitest'
import type { World } from './world.js'
import { contains, dateForms, formatReport, openReadOnly, writeEval } from './write-eval.js'

const DAY = 86400000
const date = (d: number) => new Date(Date.parse('2026-08-01T00:00:00Z') + (d - 1) * DAY).toISOString().slice(0, 10)

/** 假世界：只要 facts 和 days（剧本几乎为空，所以表里其它候选值都算“从未为真”；第 1 天一句闲聊“地铁好挤”） */
const w: World = {
  seed: 0, start: '2026-08-01', people: [], probes: [],
  days: Array.from({ length: 100 }, (_, i) => ({ day: i + 1, date: date(i + 1), sessions: i === 0 ? [{ person: 'p_owner', lines: [{ who: 'p_owner', text: '地铁好挤' }] }] : [] })),
  facts: [
    { kind: 'stable', key: '过敏', values: [{ value: '芒果', day: 3 }] },
    { kind: 'stable', key: '鞋码', values: [{ value: '42', day: 12 }] },
    { kind: 'stable', key: '血型', values: [{ value: 'O', day: 30 }] },
    { kind: 'changing', key: '城市', values: [{ value: '苏州', day: 5 }, { value: '成都', day: 20 }] },
    { kind: 'changing', key: '通勤', values: [{ value: '坐地铁', core: '地铁', day: 8 }, { value: '开车', day: 40 }] },
    { kind: 'date', key: '剪头', values: [{ value: '剪头', core: '寸头', day: 10 }] },
  ],
}

const tmp = mkdtempSync(join(tmpdir(), 'write-eval-'))
const path = join(tmp, 'memory.db')
const store = MemoryStore.open(path, { ownerName: '老大' })
const at = (d: number, hm = '20:00') => new Date(`${date(d)}T${hm}:00+08:00`)
const keep = (content: string, d: number, extra: Partial<KeepInput> = {}, hm?: string) => {
  const r = store.keep({ content, importance: '一般', about: '对方', kind: '事实', ...extra }, { viewer: { person: 'p_owner', channel: 'private' }, now: at(d, hm) })
  if (!r.ok) throw new Error(r.reason)
  return r.id
}
const m1 = keep('老大对芒果过敏。', 3)                                            // 准确
const m2 = keep('老大对花生过敏。', 4)                                            // 写错（花生从未为真）
const m3 = keep('老大搬到苏州了。', 5)                                            // 准确；第 20 天被 m5 取代（正当）
const m4 = keep('老大住在苏州，上班很近。', 6)                                     // 准确；城市变了以后没被处理 → 更新遗漏
const m6 = keep('老大对芒果过敏，吃了会起疹子。', 8, { supersedes: m1 })           // 取代了 stable 事实 → 误取代（合并式）
const m12 = keep('老大坐地铁上班。', 8)                                           // 准确；第 40 天换开车后被 m13 取代
const m15 = keep('老大说今天地铁好挤。', 7)                                       // 闲聊：“地铁”也在闲聊里出现过，只认完整的“坐地铁”→ 不判、不算超前
const m7 = keep('老大今天去剪了个寸头。', 10, { occurredAt: date(10) }, '23:50')   // 日期类召回（occurred_at 对得上）
const m8 = keep('老大穿42码的鞋。', 12)                                           // 准确；被 m9 取代 → 误取代（值丢了）
keep('老大今天买了新鞋。', 15, { supersedes: m8 })                                 // 不涉及键控事实，不判
const m5 = keep('老大搬到成都了，新家不错。', 20, { supersedes: m3 }, '23:50')     // 准确；(a) 新值 2 天内写入
const m10 = keep('老大住在苏州。', 25)                                            // 过时（当时已是成都）
keep('老大以前住在苏州。', 26)                                                     // 回顾词 → 准确
keep('小雨说她也对芒果过敏。', 27)                                                 // 只是提到真值 → 准确（主人可见的书里）
const m13 = keep('老大现在开车上班了。', 41, { supersedes: m12 }, '23:50')         // 换通勤：(a) ✓（第 41 天在 2 天内）(b) ✓
store.close()

const db = openReadOnly(path)
const r = writeEval(db, w, 100)
afterAll(() => { db.close(); rmSync(tmp, { recursive: true, force: true }) })

describe('写入侧四率', () => {
  it('认词：字母 / 数字要边界，不分大小写；中文直接找', () => {
    expect(contains('老大是AB型血', 'B')).toBe(false)
    expect(contains('老大是AB型血', 'AB')).toBe(true)
    expect(contains('老大是O型血', 'O')).toBe(true)
    expect(contains('老大穿142码', '42')).toBe(false)
    expect(contains('老大穿42码的鞋', '42')).toBe(true)
    expect(contains('老大用VIVO', 'vivo')).toBe(true)
    expect(contains('老大坐地铁上班', '地铁')).toBe(true)
    expect(dateForms('2026-08-05')).toEqual(['2026-08-05', '8月5日', '8月5号', '08月05日', '8.5', '08-05'])
  })

  it('写入召回：8 个真值中 7 个 2 天内写下了（血型没写）；日期类要日期对得上', () => {
    expect(r.recall.total).toBe(8)   // 芒果 42 O 苏州 成都 坐地铁 开车 剪头 → 其中 O 没写
    expect(r.recall.hit).toBe(7)
    expect(r.recall.byKind).toEqual({ stable: { total: 3, hit: 2 }, changing: { total: 4, hit: 4 }, date: { total: 1, hit: 1 } })
    expect(r.recall.items.find((x) => x.key === '血型')!.hit).toBe(false)
    expect(r.recall.items.find((x) => x.key === '剪头')!.ids).toEqual([m7])
    expect(r.recall.items.find((x) => x.value === '开车')!.ids).toEqual([m13])
    expect(r.rates.writeRecall).toBeCloseTo(7 / 8)
  })

  it('写入准确：写错 1（花生）、过时 1（第 25 天还说苏州）、回顾词的算准确、没提键控事实的不判', () => {
    expect(r.accuracy.judged).toBe(12)
    expect(r.accuracy.accurate).toBe(10)
    expect(r.accuracy.wrong).toBe(1)
    expect(r.accuracy.stale).toBe(1)
    expect(r.accuracy.ahead).toBe(0)
    expect(r.accuracy.items.find((x) => x.id === m2)!.verdict).toBe('写错')
    expect(r.accuracy.items.find((x) => x.id === m10)!.verdict).toBe('过时')
    expect(r.accuracy.items.find((x) => x.id === m4)!.verdict).toBe('准确')
    expect(r.accuracy.items.some((x) => x.id === m15)).toBe(false)
    expect(r.rates.writeAccuracy).toBeCloseTo(10 / 12)
  })

  it('更新遗漏：城市变了，新值写了但 m4 没被处理；通勤变了两头都对', () => {
    expect(r.update.changes).toBe(2)
    expect(r.update.ok).toBe(1)
    expect(r.update.aOk).toBe(2)
    expect(r.update.bOk).toBe(1)
    const city = r.update.items.find((x) => x.key === '城市')!
    expect(city.a).toBe(true)
    expect(city.b).toBe(false)
    expect(city.stale).toBe(2)       // m3 m4
    expect(city.handled).toBe(1)     // m3
    expect(city.timely).toBe(1)
    expect(city.unhandled.map((u) => u.id)).toEqual([m4])
    const commute = r.update.items.find((x) => x.key === '通勤')!
    expect(commute).toMatchObject({ a: true, b: true, stale: 1, handled: 1, timely: 1 })
    expect(r.update.staleTotal).toBe(3)
    expect(r.update.staleHandled).toBe(2)
    expect(r.rates.updateMiss).toBeCloseTo(0.5)
  })

  it('更新幻觉：被取代 4 条，涉及键控事实 3 条；苏州→成都、地铁→开车 正当，芒果（合并式）和 42 码（值丢了）是误取代', () => {
    expect(r.hallucination.superseded).toBe(4)
    expect(r.hallucination.judged).toBe(4)
    expect(r.hallucination.wrong).toBe(2)
    expect(r.hallucination.merged).toBe(1)
    const by = (id: string) => r.hallucination.items.find((x) => x.id === id)!
    expect(by(m3)).toMatchObject({ wrong: false, replacers: [m5] })
    expect(by(m12)).toMatchObject({ wrong: false, replacers: [m13] })
    expect(by(m1)).toMatchObject({ wrong: true, merged: true, replacers: [m6] })
    expect(by(m8)).toMatchObject({ wrong: true, merged: false })
    expect(r.rates.updateHallucination).toBeCloseTo(0.5)
  })

  it('只看到第 day 天为止：第 19 天时城市还没变，更新遗漏没得算；m3 那时还没被取代', () => {
    const early = writeEval(db, w, 19)
    expect(early.update.changes).toBe(0)
    expect(early.recall.total).toBe(5)              // 芒果 42 苏州 坐地铁 剪头
    expect(early.hallucination.superseded).toBe(2)  // m1（第 8 天）m8（第 15 天）；m3 第 20 天才被取代
    expect(early.accuracy.items.some((x) => x.id === m5)).toBe(false)
  })

  it('报告是中文 markdown 表，四行指标都在', () => {
    const md = formatReport(r, '测试')
    expect(md).toContain('| 写入召回 |')
    expect(md).toContain('| 写入准确 |')
    expect(md).toContain('| 更新遗漏 |')
    expect(md).toContain('| 更新幻觉 |')
    expect(md).toContain(m4)
  })
})
