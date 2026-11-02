// 开关 W：follow_up 工具多“分量”和“改日子”；不开时工具定义不变；夜里只列今天动过的（N4）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, OWNER_ID } from '@dsh-companion/memory'
import { followUpList, followUpTool, keepMemoryTool } from '../src/index.js'

const owner = { person: OWNER_ID, channel: 'private' }
const at = (s: string) => new Date(`${s}+08:00`)
let dir: string
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fuw-plugin-'))
  store = MemoryStore.open(join(dir, 'm.db'), { ownerName: '老大' })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('follow_up 工具（W）', () => {
  it('不开 W：工具定义和以前一样（没有 weight、没有改日子）', () => {
    const t = followUpTool(store, () => owner)
    expect(JSON.stringify(t.parameters)).not.toContain('weight')
    expect(t.description).not.toContain('改日子')
  })

  it('开 W：能标小事、能改日子', async () => {
    const now = () => at('2026-10-20T20:00:00')
    const t = followUpTool(store, () => owner, now, undefined, { weight: true })
    const r = (await t.execute({ action: '惦记', what: '老大周末去吃火锅', ask_after: '2026-10-25', weight: '小事' })) as { ok: boolean; id: string }
    expect(r.ok).toBe(true)
    expect(store.openFollowUps(owner)[0]!.weight).toBe('小事')
    const m = (await t.execute({ action: '改日子', id: r.id, ask_after: '2026-11-01' })) as { ok: boolean }
    expect(m.ok).toBe(true)
    expect(store.openFollowUps(owner)[0]!.ask_after).toBe('2026-11-01')
  })
})

describe('夜间清单 N4', () => {
  it('给了今天的对话：只列今天动过的，其余报件数', () => {
    const mk = (what: string, askAfter: string) => store.followUp({ what, askAfter }, { viewer: owner, now: at('2026-10-10T20:00:00') })
    mk('老大面试，问问结果', '2026-10-20')
    mk('老大考科目二，问问过没过', '2026-11-20')
    mk('老大体检，问问报告', '2026-11-25')
    const now = at('2026-10-20T23:50:00')
    expect(followUpList(store, owner, now)).toHaveLength(3)
    const l = followUpList(store, owner, now, { touchedBy: '下个月考科目二，有点慌' })
    expect(l).toHaveLength(3)
    expect(l.filter((x) => x.startsWith('['))).toHaveLength(2) // 到时候的面试 + 说到的科目二
    expect(l.at(-1)).toContain('另外还惦记着 1 件')
  })
})

describe('keep_memory 同义键（S）', () => {
  it('不开 S：工具定义里没有 keys；开了能写，写的键能翻到', async () => {
    expect(JSON.stringify(keepMemoryTool(store, () => owner, '老大').parameters)).not.toContain('"keys"')
    const t = keepMemoryTool(store, () => owner, '老大', () => at('2026-10-20T20:00:00'), undefined, { synonyms: true })
    const r = (await t.execute({ content: '老大的血是AB型。', importance: '很重要', about: '对方', kind: '事实', keys: ['血型'] })) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(store.recall({ query: '血型' }, owner, at('2026-10-21T10:00:00')).found).toBe(true)
  })
})
