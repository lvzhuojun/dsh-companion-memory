// 开关 R 预翻（取代 J）：问到以前的事时代码替她翻完、结果全给、没翻到也明说；规则 C′
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, OWNER_ID, PRERECALL_HEAD, PRERECALL_NONE } from '@dsh-companion/memory'
import { makeNoticer, memoryRules } from '../src/index.js'

const owner = { person: OWNER_ID, channel: 'private' }
const at = (s: string) => new Date(`${s}+08:00`)
let dir: string
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prerecall-'))
  store = MemoryStore.open(join(dir, 'm.db'), { ownerName: '老大' })
  for (let i = 0; i < 10; i++) store.keep({ content: `老大说今天第${i}次加班到很晚。`, importance: '一般', about: '对方', kind: '事实' }, { viewer: owner, now: at(`2026-10-${10 + i}T20:00:00`) })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const noticer = (prefixIds: string[] = []) => makeNoticer({ store, viewer: () => owner, inject: false, followTrigger: false, prerecall: true, prefixIds: () => prefixIds, names: () => ['老大'], now: () => at('2026-10-30T09:00:00') })

describe('预翻 R', () => {
  it('问到记着的事：给出全部结果（前缀里已有的也列，带编号），不再叫她照常翻', () => {
    const r = store.keep({ content: '老大对芒果过敏，吃了会起疹子。', importance: '一般', about: '对方', kind: '事实' }, { viewer: owner, now: at('2026-10-01T20:00:00') })
    if (!r.ok) throw new Error(r.reason)
    const t = noticer([r.id])('我对什么过敏来着？')
    expect(t.startsWith(PRERECALL_HEAD)).toBe(true)
    expect(t).toContain(`[${r.id}]`)
    expect(t).toContain('芒果')
  })

  it('问到以前的事但没记过：明说“我刚翻过：没找到”', () => {
    expect(noticer()('我初恋叫什么名字来着？')).toBe(PRERECALL_NONE)
  })

  it('闲聊、没线索：不触发（不往历史里塞东西）', () => {
    expect(noticer()('今天好热啊')).toBe('')
  })

  it('闲聊和记过的琐事字面重合也不触发（11-01：以前按门控会翻，完整档 35% 的闲聊都在往历史里塞旧琐事）', () => {
    for (let i = 0; i < 3; i++) store.keep({ content: `老大住的那栋楼电梯坏了，他爬了八楼才上去（第${i}次）。`, importance: '小事', about: '对方', kind: '经历' }, { viewer: owner, now: at('2026-10-28T20:00:00') })
    expect(noticer()('电梯坏了爬了八楼')).toBe('')
    expect(noticer()('电梯坏了好几次了，我上次爬了几楼来着？')).toContain('电梯')
  })

  it('问到别人：附隐私引导', () => {
    store.ensurePerson('p_friend', '阿杰')
    expect(noticer()('阿杰最近怎么样？')).toContain('阿杰单独跟我聊的事不会出现在这里')
  })
})

describe('实体核对 V', () => {
  const v = () => makeNoticer({ store, viewer: () => owner, inject: false, followTrigger: false, prerecall: true, verify: true, prefixIds: () => [], names: () => ['老大'], now: () => at('2026-10-30T09:00:00') })
  const keep = (content: string, about: '对方' | '别人') => { const r = store.keep({ content, importance: '一般', about, kind: about === '别人' ? '印象' : '事实' }, { viewer: owner, now: at('2026-10-28T20:00:00') }); if (!r.ok) throw new Error(r.reason) }

  it('问自己、记的是别人的事：附核对（不改结果、不替她回答）', () => {
    keep('老大的妈妈前阵子去了趟青岛。', '别人')
    const t = v()('我前阵子是不是去了趟青岛来着？')
    expect(t).toContain('青岛')
    expect(t).toContain('记的是别人的事，不是老大自己的')
  })

  it('对照：问“我妈”，记的也是妈妈的事：不附核对', () => {
    keep('老大的妈妈前阵子去了趟青岛。', '别人')
    expect(v()('我妈是不是去了趟青岛？')).not.toContain('核对')
  })

  it('问别人、记的是老大自己的事：附核对；条目里提到了那个人就不附', () => {
    keep('老大在学潜水，下个月去考证。', '对方')
    expect(v()('我同事是不是在学潜水？')).toContain('记的是老大自己的事')
    keep('老大说同事小孙也想学潜水。', '对方')
    expect(v()('我同事是不是在学潜水？')).not.toContain('核对')
  })

  it('不开 V：和 R 一样，不附核对', () => {
    keep('老大的妈妈前阵子去了趟青岛。', '别人')
    expect(noticer()('我前阵子是不是去了趟青岛来着？')).not.toContain('核对')
  })
})

describe('规则 C′', () => {
  const base = { ownerName: '老大', privateDiaryAudited: true, memory: true, askFirst: true, timeCalc: true }
  it('开 R：不再“照常去翻”，换成“先看心里记得的和刚翻过的，写着就直接用”；C、J 那两行不出现', () => {
    const r = memoryRules({ ...base, prerecall: true, inject: true })
    expect(r).toContain('【我刚翻过】')
    expect(r).toContain('写着就直接用，不用再翻核对')
    expect(r).not.toContain('照常去翻')
    expect(r).not.toContain('就先翻一翻再答')
    expect(r).not.toContain('【我想起来的】')
  })
  it('不开 R：和以前逐字一样', () => {
    expect(memoryRules({ ...base, prerecall: false })).toBe(memoryRules(base))
  })
})
