// 联想（开关 H）：顺着翻到的几条里少见的词再翻一次——长链路（100 天模拟 v2 真实量级里长链路 0%）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, OWNER_ID, type Viewer } from '../src/index.js'

const owner: Viewer = { person: OWNER_ID, channel: 'private' }
let dir: string
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'assoc-'))
  store = MemoryStore.open(join(dir, 'memory.db'), { ownerName: '老大' })
  const keep = (content: string, d: string) => store.keep({ content, importance: '一般', about: '对方', kind: '事实' }, { viewer: owner, now: new Date(`${d}T21:00:00+08:00`) })
  keep('老大组里新来了个同事叫阿伟，人挺好的。', '2026-08-05')
  keep('阿伟跳槽了，去了蓝海科技。', '2026-09-10')
  keep('老大听说蓝海科技被收购了。', '2026-10-20')
  for (let i = 0; i < 10; i++) keep(`老大今天吃了第 ${i} 碗面。`, '2026-10-01')
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('联想', () => {
  it('按问题只翻得到前两条；顺着“蓝海科技”带出第三条', () => {
    const q = '同事 跳槽'
    const r = store.recall({ query: q }, owner)
    expect(r.items.map((i) => i.text).join()).not.toContain('收购')
    const more = store.associate(r.items, q, owner)
    expect(more.map((i) => i.text).join()).toContain('收购')
  })

  it('不重复已经翻到的；没有桥就什么都不带', () => {
    const r = store.recall({ query: '同事 跳槽' }, owner)
    const more = store.associate(r.items, '同事 跳槽', owner)
    expect(more.every((m) => !r.items.some((i) => i.id === m.id))).toBe(true)
    const solo = store.recall({ query: '面' }, owner)
    expect(store.associate([], '面', owner)).toEqual([])
    expect(store.associate(solo.items, '面', owner).length).toBeLessThanOrEqual(3)
  })
})
