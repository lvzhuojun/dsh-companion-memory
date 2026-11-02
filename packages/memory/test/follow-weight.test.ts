// 开关 W：惦记分大事 / 小事、每天“该问问了”合计 1 件、挑时机、改日子
// 代码只决定“这一轮要不要让她想起来”，说什么、怎么问都是她自己的话
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { followUpSaid, MemoryStore, OWNER_ID, type Viewer } from '../src/index.js'

const owner: Viewer = { person: OWNER_ID, channel: 'private' }
const at = (s: string) => new Date(`${s}+08:00`)
const W = { weighted: true }
let dir: string
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fuw-'))
  store = MemoryStore.open(join(dir, 'memory.db'), { ownerName: '老大' })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})
const fu = (what: string, askAfter: string, o: { weight?: '大事' | '小事'; keys?: string[] } = {}) => {
  const r = store.followUp({ what, askAfter, ...o }, { viewer: owner, now: at('2026-10-20T20:00:00') })
  if (!r.ok) throw new Error(r.reason)
  return r.id
}

describe('W：每天合计最多 1 件', () => {
  it('同一天三件到期：开 W 只提一件；不开 W 和以前一样一件一件提', () => {
    fu('老大面试，问问结果', '2026-10-29')
    fu('老大体检，问问报告', '2026-10-29')
    fu('老大搬家，问问顺不顺', '2026-10-29')
    expect(store.followUpNotice(owner, '在吗', at('2026-10-29T10:00:00'), W)?.why).toBe('due')
    expect(store.followUpNotice(owner, '在吗', at('2026-10-29T11:00:00'), W)).toBeUndefined()
    expect(store.followUpNotice(owner, '在吗', at('2026-10-29T12:00:00'))?.why).toBe('due')
  })

  it('对方自己说到另一件：仍然可以接（不占名额、也不受名额限制）', () => {
    fu('老大面试，问问结果', '2026-10-29')
    fu('老大考科目二，问问过没过', '2026-11-20', { keys: ['科目二'] })
    expect(store.followUpNotice(owner, '在吗', at('2026-10-29T10:00:00'), W)?.why).toBe('due')
    expect(store.followUpNotice(owner, '我下个月考科目二', at('2026-10-29T11:00:00'), W)?.why).toBe('key')
  })
})

describe('W：挑时机', () => {
  it('对方在难受 / 求助：先不提“该问问了”，也不占当天名额；缓过来再提', () => {
    const id = fu('老大面试，问问结果', '2026-10-29')
    expect(store.followUpNotice(owner, '今天被骂了好难受', at('2026-10-29T10:00:00'), W)).toBeUndefined()
    expect(store.followUpNotice(owner, '电脑蓝屏了怎么办', at('2026-10-29T10:05:00'), W)).toBeUndefined()
    expect(store.followUpNotice(owner, '好点了', at('2026-10-29T20:00:00'), W)?.row.id).toBe(id)
  })

  it('长篇讲别的事：先不提；打招呼开头的长话不算', () => {
    fu('老大面试，问问结果', '2026-10-29')
    const long = '我跟你说今天地铁上遇到一个特别奇怪的人，' + '他一直在念叨什么东西，'.repeat(8)
    expect(store.followUpNotice(owner, long, at('2026-10-29T10:00:00'), W)).toBeUndefined()
    expect(store.followUpNotice(owner, '我回来啦' + long, at('2026-10-29T11:00:00'), W)?.why).toBe('due')
  })
})

describe('W：分量', () => {
  it('小事不做到日子提醒，只在对方说到时想起来；不写放下日时 3 天后放下', () => {
    const id = fu('老大说周末去吃那家火锅', '2026-10-29', { weight: '小事' })
    expect(store.followUpNotice(owner, '在吗', at('2026-10-29T10:00:00'), W)).toBeUndefined()
    expect(store.followUpNotice(owner, '那家火锅真的绝了', at('2026-10-29T11:00:00'), W)?.row.id).toBe(id)
    expect(store.openFollowUps(owner)[0]!.give_up_after).toBe('2026-11-01')
  })

  it('不写分量就是大事（旧行为）', () => {
    fu('老大面试，问问结果', '2026-10-29')
    expect(store.openFollowUps(owner)[0]!.weight).toBe('大事')
  })

  it('没给触发词：那句话里的事情词也算说到了', () => {
    expect(followUpSaid({ what: '老大周五面试，问问结果', trigger_keys: '[]' }, '面试好紧张')).toBe(true)
    expect(followUpSaid({ what: '老大周五面试，问问结果', trigger_keys: '[]' }, '今天好热')).toBe(false)
  })
})

describe('W：改日子', () => {
  it('改到新的日子：提醒和问过的计数清零，到新日子再提', () => {
    const id = fu('老大面试，问问结果', '2026-10-29')
    store.followUpNotice(owner, '在吗', at('2026-10-29T10:00:00'), W)
    store.markFollowUp(id, 'asked', owner, { now: at('2026-10-29T10:01:00') })
    const r = store.markFollowUp(id, 'rescheduled', owner, { askAfter: '2026-11-06', now: at('2026-10-29T10:02:00') })
    expect(r.ok).toBe(true)
    const row = store.openFollowUps(owner)[0]!
    expect(row).toMatchObject({ ask_after: '2026-11-06', give_up_after: '2026-11-13', asked_count: 0, notice_count: 0 })
    expect(store.followUpNotice(owner, '在吗', at('2026-10-30T10:00:00'), W)).toBeUndefined()
    expect(store.followUpNotice(owner, '在吗', at('2026-11-06T10:00:00'), W)?.row.id).toBe(id)
  })

  it('日子不对：不改', () => {
    const id = fu('老大面试，问问结果', '2026-10-29')
    expect(store.markFollowUp(id, 'rescheduled', owner, { askAfter: '下周', now: at('2026-10-29T10:00:00') }).ok).toBe(false)
    expect(store.markFollowUp(id, 'rescheduled', owner, { askAfter: '2026-10-01', now: at('2026-10-29T10:00:00') }).ok).toBe(false)
  })
})
