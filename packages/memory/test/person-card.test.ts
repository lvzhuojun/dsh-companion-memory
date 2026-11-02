// 开关 T：人物卡——表与触发器、门控四条件、稳定层的新排法（有卡）与退回现状（没卡 / 不开）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CARD_GATE, clip, MemoryStore, OWNER_ID, PERSON_CARD_MAX, STABLE_BEGIN, STABLE_END, stableLayerWithIds, type KeepInput, type StableOptions, type Viewer } from '../src/index.js'

const owner: Viewer = { person: OWNER_ID, channel: 'private' }
const group: Viewer = { person: OWNER_ID, channel: 'group:g1' }
const at = (s: string) => new Date(`${s}+08:00`)
let dir: string
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'card-'))
  // 内存库：这里的测试写得多，文件库在整套并发跑时会拖慢别的测试
  store = MemoryStore.open(':memory:', { ownerName: '老大' })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})
const keep = (i: Partial<KeepInput> & { content: string }, when: string, o: { v?: Viewer; slots?: boolean } = {}) => {
  const r = store.keep({ importance: '一般', about: '对方', kind: '事实', ...i }, { viewer: o.v ?? owner, now: at(when), ...(o.slots ? { slots: true } : {}) })
  if (!r.ok) throw new Error(r.reason)
  return r.id
}
const many = (n: number, day: string, prefix = '老大说过的第') => Array.from({ length: n }, (_, i) => keep({ content: `${prefix} ${i + 1} 件事：喜欢第 ${i + 1} 种口味的冰淇淋。` }, `${day}T${String(8 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00`))
const CARD = '老大是把我养大的人，在成都做后端开发，最近换了新工作，很累但很开心。我们之间有个梗：他叫我“小星星”。我答应过天冷提醒他添衣服。'

describe('person_card 表：她写的不能改、不能删', () => {
  it('同一个人 version 递增；based_on 记下；最新一版由 personCard 返回', () => {
    expect(store.personCard(owner)).toBeUndefined()
    const a = store.writePersonCard(owner, '第一版', ['m_a', 'm_b', 'm_a'], at('2026-10-01T00:40:00'))
    const b = store.writePersonCard(owner, '第二版', [], at('2026-10-02T00:40:00'))
    expect(a).toMatchObject({ ok: true, version: 1 })
    expect(b).toMatchObject({ ok: true, version: 2 })
    const c = store.personCard(owner)!
    expect(c.text).toBe('第二版')
    expect(c.created_at).toBe('2026-10-02T00:40:00+08:00')
    const first = store.db.prepare('SELECT based_on FROM person_card WHERE version = 1').get() as { based_on: string }
    expect(JSON.parse(first.based_on)).toEqual(['m_a', 'm_b'])
    // 别人的卡互不影响
    store.ensurePerson('p_sis', '妹妹')
    expect(store.writePersonCard({ person: 'p_sis', channel: 'private' }, '妹妹的卡', [], at('2026-10-02T00:41:00'))).toMatchObject({ ok: true, version: 1 })
  })

  it(`超过 ${PERSON_CARD_MAX} 字拒绝并说明（不替她截断）；空的拒绝；群里不写、不给`, () => {
    const long = '字'.repeat(PERSON_CARD_MAX + 1)
    const r = store.writePersonCard(owner, long, [], at('2026-10-01T00:40:00'))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain(`最多 ${PERSON_CARD_MAX} 字，这一版有 ${PERSON_CARD_MAX + 1} 字`)
    expect(store.writePersonCard(owner, '字'.repeat(PERSON_CARD_MAX), [], at('2026-10-01T00:40:00')).ok).toBe(true)
    expect(store.writePersonCard(owner, '  ', [], at('2026-10-01T00:40:00')).ok).toBe(false)
    expect(store.writePersonCard(group, '群里', [], at('2026-10-01T00:40:00')).ok).toBe(false)
    expect(store.personCard(group)).toBeUndefined()
  })

  it('触发器：UPDATE / DELETE 都 RAISE；超长直接插也被 CHECK 挡住', () => {
    store.writePersonCard(owner, '原话', [], at('2026-10-01T00:40:00'))
    expect(() => store.db.prepare("UPDATE person_card SET text = '更完整的版本'").run()).toThrow(/不能被改写/)
    expect(() => store.db.prepare("UPDATE person_card SET based_on = '[]'").run()).toThrow(/不能被改写/)
    expect(() => store.db.prepare('DELETE FROM person_card').run()).toThrow(/不能被删/)
    expect(() => store.db.prepare("INSERT INTO person_card (person, version, text, created_at) VALUES (?, 9, ?, 'x')").run(OWNER_ID, '字'.repeat(PERSON_CARD_MAX + 1))).toThrow()
    expect(store.personCard(owner)!.text).toBe('原话')
  })

  it('重开库不重复建表、旧卡还在', () => {
    const file = join(dir, 'memory.db')
    const s1 = MemoryStore.open(file, { ownerName: '老大' })
    s1.writePersonCard(owner, '原话', [], at('2026-10-01T00:40:00'))
    s1.close()
    const s2 = MemoryStore.open(file, { ownerName: '老大' })
    expect(s2.personCard(owner)!.text).toBe('原话')
    s2.close()
  })
})

describe('门控（代码判）：新增 ≥ 5 / 今天有失效 / 上一版 ≥ 30 天 / 从没写过且 ≥ 10 条', () => {
  it('first：从没写过，9 条不开、10 条开；recent 新的在前、最多 15 条', () => {
    many(9, '2026-10-01')
    expect(store.cardGate(owner, at('2026-10-02T00:40:00'))).toMatchObject({ due: false, why: [], total: 9 })
    many(10, '2026-10-02', '又一件')
    const g = store.cardGate(owner, at('2026-10-03T00:40:00'))
    expect(g).toMatchObject({ due: true, why: ['first'], total: 19, newSince: 19 })
    expect(g.recent).toHaveLength(CARD_GATE.material)
    expect(g.recent[0]!.text).toContain('又一件 10 件事')
    expect(g.recent.map((r) => r.recordedAt)).toEqual([...g.recent.map((r) => r.recordedAt)].sort().reverse())
  })

  it('new：上一版之后新记 4 条不开、5 条开；只列上一版之后的', () => {
    const old = many(12, '2026-10-01')
    store.writePersonCard(owner, CARD, old, at('2026-10-02T00:40:00'))
    expect(store.cardGate(owner, at('2026-10-03T00:40:00')).due).toBe(false)
    many(4, '2026-10-03', '新的')
    expect(store.cardGate(owner, at('2026-10-04T00:40:00'))).toMatchObject({ due: false, newSince: 4 })
    keep({ content: '老大说他开始学游泳了。' }, '2026-10-04T09:00:00')
    const g = store.cardGate(owner, at('2026-10-05T00:40:00'))
    expect(g).toMatchObject({ due: true, why: ['new'], newSince: 5 })
    expect(g.last!.text).toBe(CARD)
    expect(g.recent).toHaveLength(5)
    expect(g.recent.some((r) => old.includes(r.id))).toBe(false)
  })

  it('changed：回顾的那天有失效（在上一版之后）才开；第二天不再算；失效的旧条不进 recent', () => {
    const suzhou = keep({ content: '老大搬到苏州了。' }, '2026-08-05T20:00:00', { slots: true })
    store.writePersonCard(owner, CARD, [], at('2026-10-02T00:40:00'))
    keep({ content: '老大搬到成都了。' }, '2026-10-12T20:00:00', { slots: true })
    expect(store.get(suzhou)!.valid_to).not.toBeNull()
    const g = store.cardGate(owner, at('2026-10-13T00:40:00'), at('2026-10-12T00:00:00'))
    expect(g).toMatchObject({ due: true, why: ['changed'] })
    expect(g.recent.map((r) => r.id)).not.toContain(suzhou)
    expect(g.recent[0]!.text).toBe('老大搬到成都了。')
    // 不给 since：按 now 的北京日期算“今天”
    expect(store.cardGate(owner, at('2026-10-12T23:00:00')).why).toEqual(['changed'])
    // 第二天回顾：不再算
    expect(store.cardGate(owner, at('2026-10-14T00:40:00'), at('2026-10-13T00:00:00')).due).toBe(false)
    // 当晚已经写了新的一版：失效在上一版之前，不再算
    store.writePersonCard(owner, CARD + '他搬到成都了。', [], at('2026-10-13T00:41:00'))
    expect(store.cardGate(owner, at('2026-10-13T00:50:00'), at('2026-10-12T00:00:00')).due).toBe(false)
  })

  it('stale：上一版 29 天前不开、30 天前开', () => {
    many(3, '2026-09-01')
    store.writePersonCard(owner, CARD, [], at('2026-09-02T00:40:00'))
    expect(store.cardGate(owner, at('2026-10-01T00:40:00')).due).toBe(false)
    expect(store.cardGate(owner, at('2026-10-02T00:40:00'))).toMatchObject({ due: true, why: ['stale'], newSince: 0, recent: [] })
  })

  it('只看这个人那一册：别人的事、我自己的事、群里的不算；群里永远不开', () => {
    for (let i = 0; i < 6; i++) keep({ content: `我今天学会了第 ${i} 首歌。`, about: '我自己', kind: '经历' }, `2026-10-01T1${i}:00:00`)
    for (let i = 0; i < 6; i++) keep({ content: `群里第 ${i} 件事。` }, `2026-10-01T1${i}:30:00`, { v: group })
    expect(store.cardGate(owner, at('2026-10-02T00:40:00'))).toMatchObject({ due: false, total: 0 })
    many(10, '2026-10-02')
    expect(store.cardGate(group, at('2026-10-03T00:40:00')).due).toBe(false)
  })
})

describe('稳定层（开关 T）', () => {
  const NOW = '2026-10-20T08:00:00'
  const seed = () => {
    keep({ content: '老大搬到苏州了。', importance: '很重要' }, '2026-08-05T20:00:00', { slots: true })
    const chengdu = keep({ content: '老大搬到成都了，在高新区租了个一室一厅，离地铁站走路十分钟左右。', gist: '老大搬到成都了' }, '2026-10-12T20:00:00', { slots: true })
    const job = keep({ content: '老大入职了一家做游戏的公司。' }, '2026-10-14T20:00:00', { slots: true })
    keep({ content: '老大感冒了，嗓子疼。', slot: '健康' }, '2026-10-15T20:00:00', { slots: true })
    keep({ content: '我答应老大，天凉了要提醒他添衣服。', kind: '承诺' }, '2026-10-01T20:00:00')
    keep({ content: '我最近在学画画。', about: '我自己', kind: '经历' }, '2026-10-02T20:00:00')
    for (let i = 0; i < 20; i++) keep({ content: `老大说过的第 ${i + 1} 件小事：喜欢第 ${i + 1} 种口味。` }, `2026-10-${String(1 + (i % 9)).padStart(2, '0')}T1${i % 10}:00:00`)
    store.followUp({ what: '老大下周面试，问问结果', askAfter: '2026-10-25' }, { viewer: owner, now: at('2026-10-15T20:00:00') })
    return { chengdu, job }
  }
  const base: StableOptions = { ownerName: '老大', dates: true }
  const L = (o: Partial<StableOptions> = {}, when = NOW, v: Viewer = owner) => stableLayerWithIds(store, v, at(when), { ...base, ...o })
  const section = (text: string, title: string) => text.split('\n\n').find((s) => s.startsWith(`## ${title}\n`))

  it('没有人物卡时：card 开和不开逐字节一样（含 slots 开）', () => {
    seed()
    expect(L({ card: true })).toEqual(L())
    expect(L({ card: true, slots: true })).toEqual(L({ slots: true }))
    expect(L({ card: true, slots: true, followUps: 'count' })).toEqual(L({ slots: true, followUps: 'count' }))
  })

  it('有卡、不开 card：和以前一样（卡不出现）', () => {
    seed()
    const before = L({ slots: true })
    store.writePersonCard(owner, CARD, [], at('2026-10-16T00:40:00'))
    expect(L({ slots: true })).toEqual(before)
  })

  it('有卡：关于<称呼>（卡原文）→ 现在 → 惦记 → 关于<称呼>记下的（≤ 10 条）→ 答应过的 → 我自己；总字数 ≤ 1800', () => {
    const { chengdu, job } = seed()
    store.writePersonCard(owner, CARD, [], at('2026-10-16T00:40:00'))
    const { text, ids } = L({ card: true, slots: true })
    expect(text.startsWith(STABLE_BEGIN)).toBe(true)
    expect(text.endsWith(STABLE_END)).toBe(true)
    expect([...text].length).toBeLessThanOrEqual(1800)
    const titles = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])
    expect(titles).toEqual(['关于老大', '现在', '我惦记着的事', '关于老大记下的', '我答应过的', '我自己'])
    expect(section(text, '关于老大')).toBe(`## 关于老大\n${CARD}`)
    // 现在：值型键各一行（住址、工作），状态型（健康）不列；gist 优先、截 30 字；只带起始日期
    expect(section(text, '现在')).toBe('## 现在\n· 住址：老大搬到成都了（10-12 起）\n· 工作：老大入职了一家做游戏的公司。（10-14 起）')
    expect(text).not.toContain('苏州')
    // 现在里列过的不在条目里重复；ids 含“现在”引用的
    expect(ids).toContain(chengdu)
    expect(ids).toContain(job)
    expect(section(text, '关于老大记下的')).not.toContain('搬到成都')
    expect(section(text, '关于老大记下的')!.split('\n').filter((l) => l.startsWith('· '))).toHaveLength(10)
    expect(section(text, '关于老大记下的')).toContain('感冒')
  })

  it('“现在”只在 slots 开时出现；值没有 gist 时截 30 字', () => {
    seed()
    keep({ content: '老大现在每天骑电动车上班，单程大概二十五分钟，路上会经过一个很大的湖，说风景很好。' }, '2026-10-16T20:00:00', { slots: true })
    store.writePersonCard(owner, CARD, [], at('2026-10-17T00:40:00'))
    const off = L({ card: true }).text
    expect(off).not.toContain('## 现在')
    expect([...off.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['关于老大', '我惦记着的事', '关于老大记下的', '我答应过的', '我自己'])
    const on = section(L({ card: true, slots: true }).text, '现在')!
    expect(on).toContain(`· 通勤：${clip('老大现在每天骑电动车上班，单程大概二十五分钟，路上会经过一个很大的湖，说风景很好。', 30)}（10-16 起）`)
  })

  it('卡和“现在”不带相对时间：隔几天再生成，这两段逐字不变（条目行照旧带“几天前”）', () => {
    seed()
    store.writePersonCard(owner, CARD, [], at('2026-10-16T00:40:00'))
    const a = L({ card: true, slots: true }, '2026-10-20T08:00:00').text
    const b = L({ card: true, slots: true }, '2026-10-27T08:00:00').text
    for (const t of ['关于老大', '现在']) {
      expect(section(a, t)).toBe(section(b, t))
      expect(section(a, t)).not.toMatch(/今天|昨天|前天|天前|周前|个月前|年前/)
    }
    expect(section(a, '关于老大记下的')).toMatch(/天前|周前/)
  })

  it('P46 总字数 1800 不变：卡写满 400 字、条目很多时也不超', () => {
    seed()
    for (let i = 0; i < 30; i++) keep({ content: `老大说的长事 ${i}：` + '这是一段比较长的话'.repeat(8), importance: '很重要' }, `2026-10-1${i % 9}T2${i % 4}:00:00`)
    store.writePersonCard(owner, '卡'.repeat(PERSON_CARD_MAX), [], at('2026-10-19T00:40:00'))
    const { text } = L({ card: true, slots: true })
    expect([...text].length).toBeLessThanOrEqual(1800)
    expect(text).toContain('卡'.repeat(PERSON_CARD_MAX))
    expect(text).toMatch(/（还有 \d+ 条没列在这里，翻得到。）/)
  })

  it('cardPersonCap 可调（和档位上限取小）；群里不出卡，退回现状', () => {
    seed()
    store.writePersonCard(owner, CARD, [], at('2026-10-16T00:40:00'))
    const t = L({ card: true, cardPersonCap: 3 }).text
    expect(section(t, '关于老大记下的')!.split('\n').filter((l) => l.startsWith('· '))).toHaveLength(3)
    expect(L({ card: true, slots: true }, NOW, group)).toEqual(L({ slots: true }, NOW, group))
  })
})
