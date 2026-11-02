// 自检（开关 Y）：0.6 完整档没处理的四个变化（苏州→成都、开车→坐地铁、豆浆→乌龙茶、攀岩→跑步），
// 她照 0.6 的样子写新条、不填 supersedes——开 slots 时写入侧四率的 (b)（旧值记忆都处理了）应全部算已处理；关时全部遗漏。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '@dsh-companion/memory'
import { afterAll, describe, expect, it } from 'vitest'
import type { World } from './world.js'
import { openReadOnly, writeEval } from './write-eval.js'

const DAY = 86400000
const date = (d: number) => new Date(Date.parse('2026-08-01T00:00:00Z') + (d - 1) * DAY).toISOString().slice(0, 10)
const w: World = {
  seed: 0, start: '2026-08-01', people: [], probes: [],
  days: Array.from({ length: 100 }, (_, i) => ({ day: i + 1, date: date(i + 1), sessions: [] })),
  facts: [
    { kind: 'changing', key: '城市', values: [{ value: '苏州', day: 5 }, { value: '成都', day: 73 }] },
    { kind: 'changing', key: '通勤', values: [{ value: '开车', day: 8 }, { value: '坐地铁', core: '地铁', day: 40 }] },
    { kind: 'changing', key: '饮品', values: [{ value: '豆浆', day: 12 }, { value: '乌龙茶', day: 45 }] },
    { kind: 'changing', key: '运动', values: [{ value: '攀岩', day: 15 }, { value: '跑步', day: 60 }] },
  ],
}
// 她的写法照 0.6 的库（新条正文里提到旧值，但没填 supersedes）
const script: Array<[number, string]> = [
  [5, '老大搬到苏州了，新家还挺不错的。'],
  [8, '老大现在开车上班。'],
  [12, '老大最近只喝豆浆了。'],
  [15, '老大最近开始攀岩了。'],
  [40, '老大现在坐地铁上班了（以前是开车）。'],
  [45, '老大最近只喝乌龙茶了（以前只喝豆浆）。'],
  [60, '老大最近开始跑步了。'],
  [73, '老大搬到成都了，以前说过搬到苏州，这次换了地方。'],
]

const tmp = mkdtempSync(join(tmpdir(), 'write-eval-slots-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function build(slots: boolean) {
  const path = join(tmp, `${slots ? 'on' : 'off'}.db`)
  const store = MemoryStore.open(path, { ownerName: '老大' })
  for (const [d, content] of script) {
    const r = store.keep({ content, importance: '很重要', about: '对方', kind: '事实' }, { viewer: { person: 'p_owner', channel: 'private' }, now: new Date(`${date(d)}T21:00:00+08:00`), ...(slots ? { slots: true } : {}) })
    if (!r.ok) throw new Error(r.reason)
  }
  store.close()
  const db = openReadOnly(path)
  try {
    return writeEval(db, w, 100)
  } finally {
    db.close()
  }
}

describe('自检：有效期 + 键让 (b) 旧值记忆都处理了', () => {
  it('开：四个变化 (a)(b) 都过，更新遗漏 0，更新幻觉 0（2 天内处理）', () => {
    const r = build(true)
    expect(r.update.items.map((x) => [x.key, x.a, x.b, x.stale, x.handled, x.timely])).toEqual([
      ['城市', true, true, 1, 1, 1], ['通勤', true, true, 1, 1, 1], ['饮品', true, true, 1, 1, 1], ['运动', true, true, 1, 1, 1],
    ])
    expect(r.rates.updateMiss).toBe(0)
    expect(r.hallucination.wrong).toBe(0)
  })

  it('关（对照）：新值都记了，旧值一条也没处理', () => {
    const r = build(false)
    expect(r.update.aOk).toBe(4)
    expect(r.update.bOk).toBe(0)
    expect(r.rates.updateMiss).toBe(1)
  })
})
