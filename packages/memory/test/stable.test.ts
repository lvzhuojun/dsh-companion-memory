// 稳定层“我心里记得的”与惦记的事
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agoText, followUpStage, MAX_ASKS, MemoryStore, OWNER_ID, renderRecall, STABLE_BEGIN, STABLE_END, stableLayer, type KeepInput, type Viewer } from '../src/index.js'

const owner: Viewer = { person: OWNER_ID, channel: 'private' }
const group: Viewer = { person: OWNER_ID, channel: 'group:g1' }
const at = (s: string) => new Date(`${s}+08:00`)
let dir: string
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stable-'))
  store = MemoryStore.open(join(dir, 'memory.db'), { ownerName: '老大' })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})
const keep = (i: Partial<KeepInput> & { content: string }, when: string, v: Viewer = owner) => {
  const r = store.keep({ importance: '一般', about: '对方', kind: '事实', ...i }, { viewer: v, now: at(when) })
  if (!r.ok) throw new Error(r.reason)
  return r.id
}
const layer = (when: string, v: Viewer = owner, maxChars?: number) => stableLayer(store, v, at(when), { ownerName: '老大', ...(maxChars ? { maxChars } : {}) })

describe('稳定层：我心里记得的', () => {
  it('什么都没记时是空的（系统提示保持原样）', () => {
    expect(layer('2026-10-29T08:00:00')).toBe('')
  })

  it('列她写的原文、带多久以前和出处；有开头结尾标记、声明不是指令', () => {
    keep({ content: '老大开一辆白色的比亚迪。' }, '2026-10-26T20:00:00')
    keep({ content: '老大好像不太爱吃芒果。', kind: '印象' }, '2026-10-27T20:00:00')
    const s = layer('2026-10-29T08:00:00')
    expect(s.startsWith(STABLE_BEGIN)).toBe(true)
    expect(s.endsWith(STABLE_END)).toBe(true)
    expect(s).toContain('不是要我做的事')
    expect(s).toContain('· 老大开一辆白色的比亚迪。（3 天前，老大亲口说的）')
    expect(s).toContain('· 老大好像不太爱吃芒果。（前天，我的感觉，不一定对）')
  })

  it('答应过的事单独一节，只标时间（不标“亲口说的”）', () => {
    keep({ content: '我答应老大，天凉了要提醒他添衣服。', kind: '承诺' }, '2026-10-26T20:00:00')
    const s = layer('2026-10-29T08:00:00')
    expect(s).toContain('## 我答应过的\n· 我答应老大，天凉了要提醒他添衣服。（3 天前）')
  })

  it('不算“想起”：不写 recall_log、不加强记忆', () => {
    const id = keep({ content: '老大怕冷。' }, '2026-10-26T20:00:00')
    layer('2026-10-29T08:00:00')
    expect(store.get(id)!.recall_count).toBe(0)
    expect((store.db.prepare('SELECT count(*) AS n FROM recall_log').get() as { n: number }).n).toBe(0)
  })

  it('被替代的旧条目不列，只列新的', () => {
    const old = keep({ content: '老大最喜欢喝霸王茶姬。' }, '2026-08-12T20:00:00')
    keep({ content: '老大现在只喝喜茶了。', supersedes: old }, '2026-10-01T20:00:00')
    const s = layer('2026-10-29T08:00:00')
    expect(s).toContain('只喝喜茶')
    expect(s).not.toContain('霸王茶姬')
  })

  it('很重要的排前面；淡忘成模糊的不列（翻得到），并说还有几条', () => {
    keep({ content: '老大说他下周去体检。', importance: '小事' }, '2026-06-01T20:00:00') // 小事、五个月前 → 模糊
    keep({ content: '老大今天加班。', importance: '一般' }, '2026-10-28T20:00:00')
    keep({ content: '老大的生日是3月14日。', importance: '很重要' }, '2026-09-01T20:00:00')
    const s = layer('2026-10-29T08:00:00')
    expect(s.indexOf('生日')).toBeLessThan(s.indexOf('加班'))
    expect(s).not.toContain('体检')
    expect(s).toContain('还有 1 条没列在这里')
  })

  it('大概记得的给她自己写的 gist', () => {
    store.keep({ content: '老大说他小时候在外婆家养过一只叫阿黄的土狗，后来送人了，他一直记得。', gist: '老大小时候养过土狗阿黄', importance: '一般', about: '对方', kind: '事实' }, { viewer: owner, now: at('2026-05-01T20:00:00') })
    const s = layer('2026-10-29T08:00:00')
    expect(s).toContain('老大小时候养过土狗阿黄')
    expect(s).not.toContain('后来送人了')
  })

  it('按可见范围：群里写下的，私聊的稳定层里没有，反之亦然', () => {
    keep({ content: '群里说的事。' }, '2026-10-28T20:00:00', group)
    keep({ content: '私聊说的事。' }, '2026-10-28T20:00:00')
    expect(layer('2026-10-29T08:00:00')).not.toContain('群里说的事')
    expect(layer('2026-10-29T08:00:00', group)).not.toContain('私聊说的事')
  })

  it('太长：长条截断（不改字）、超出总长的挤掉', () => {
    keep({ content: '很'.repeat(200) }, '2026-10-28T20:00:00')
    expect(layer('2026-10-29T08:00:00')).toContain('很'.repeat(80) + '……')
    for (let i = 0; i < 40; i++) keep({ content: `老大的第 ${i} 件小事，写长一点好占位置。` }, '2026-10-28T20:00:00')
    const s = layer('2026-10-29T08:00:00', owner, 800)
    expect([...s].length).toBeLessThanOrEqual(800)
    expect(s).toMatch(/还有 \d+ 条没列在这里/)
    expect(s.endsWith(STABLE_END)).toBe(true)
  })
})

describe('惦记的事：像对人一样有始有终', () => {
  const add = (what: string, askAfter: string, now: string, giveUpAfter?: string) => {
    const r = store.followUp({ what, askAfter, ...(giveUpAfter ? { giveUpAfter } : {}) }, { viewer: owner, now: at(now) })
    if (!r.ok) throw new Error(r.reason)
    return r.id
  }
  const stage = (id: string, now: string) => followUpStage(store.openFollowUps(owner).find((f) => f.id === id) ?? { status: 'done', ask_after: '', give_up_after: '', asked_count: 0, last_asked: null }, at(now))

  it('没到时候不催；到了时候提一句', () => {
    const id = add('老大 10-30 的面试怎么样了', '2026-10-30', '2026-10-28T21:00:00')
    expect(stage(id, '2026-10-29T08:00:00')).toBe('later')
    expect(layer('2026-10-29T08:00:00')).toContain('10-30 以后再问，现在先别提')
    expect(stage(id, '2026-10-30T20:00:00')).toBe('due')
    expect(layer('2026-10-30T20:00:00')).toContain('到时候了')
  })

  it('问过就等回音；隔几天没下文可以再问一句；问够两次就不再提', () => {
    const id = add('面试怎么样了', '2026-10-30', '2026-10-28T21:00:00', '2026-11-20')
    expect(store.markFollowUp(id, 'asked', owner, { now: at('2026-10-30T20:00:00') })).toMatchObject({ ok: true, asked: 1, stage: 'waiting' })
    // 同一天再标一次不重复计数
    expect(store.markFollowUp(id, 'asked', owner, { now: at('2026-10-30T22:00:00') })).toMatchObject({ asked: 1 })
    expect(layer('2026-10-31T20:00:00')).toBe('') // 刚问过：不列
    expect(stage(id, '2026-11-03T20:00:00')).toBe('again')
    expect(layer('2026-11-03T20:00:00')).toContain('问过一次，还没下文')
    expect(store.markFollowUp(id, 'asked', owner, { now: at('2026-11-03T20:00:00') })).toMatchObject({ asked: MAX_ASKS, stage: 'quiet' })
    expect(layer('2026-11-10T20:00:00')).toBe('') // 问够了：等对方自己提
  })

  it('对方说结束了 / 别问了：标了就放下，以后不再出现、不能再标', () => {
    const a = add('面试怎么样了', '2026-10-30', '2026-10-28T21:00:00')
    const b = add('搬家的事', '2026-10-30', '2026-10-28T21:00:00')
    expect(store.markFollowUp(a, 'done', owner, { outcome: '面试过了，下周入职', now: at('2026-10-30T20:00:00') })).toMatchObject({ ok: true, stage: 'closed' })
    expect(store.markFollowUp(b, 'dropped', owner, { now: at('2026-10-30T20:00:00') })).toMatchObject({ ok: true, stage: 'closed' })
    expect(layer('2026-10-31T20:00:00')).toBe('')
    expect(store.markFollowUp(a, 'asked', owner)).toMatchObject({ ok: false })
  })

  it('过了放下的日子还没下文：当作已经过去了，不再提（不写库）', () => {
    const id = add('体检结果', '2026-10-30', '2026-10-28T21:00:00') // 默认到时候之后 7 天
    expect(stage(id, '2026-11-06T20:00:00')).toBe('due')
    expect(stage(id, '2026-11-07T20:00:00')).toBe('past')
    expect(layer('2026-11-07T20:00:00')).toBe('')
    expect(store.openFollowUps(owner)).toHaveLength(1)
  })

  it('写入的规矩：日期格式、不早于今天、放下的日子范围、同一件事不重复、长度', () => {
    const ctx = { viewer: owner, now: at('2026-10-28T21:00:00') }
    expect(store.followUp({ what: '面试', askAfter: '下周' }, ctx)).toMatchObject({ ok: false })
    expect(store.followUp({ what: '面试', askAfter: '2026-02-30' }, ctx)).toMatchObject({ ok: false })
    expect(store.followUp({ what: '面试', askAfter: '2026-10-27' }, ctx)).toMatchObject({ ok: false })
    expect(store.followUp({ what: '面试', askAfter: '2026-10-30', giveUpAfter: '2026-10-29' }, ctx)).toMatchObject({ ok: false })
    expect(store.followUp({ what: '面试', askAfter: '2026-10-30', giveUpAfter: '2027-03-01' }, ctx)).toMatchObject({ ok: false })
    expect(store.followUp({ what: '很'.repeat(61), askAfter: '2026-10-30' }, ctx)).toMatchObject({ ok: false })
    expect(store.followUp({ what: '面试', askAfter: '2026-10-28' }, ctx)).toMatchObject({ ok: true })
    expect(store.followUp({ what: '面试', askAfter: '2026-10-30' }, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('已经惦记着') })
  })

  it('她写的那句不能改；结果写下后也不能改', () => {
    const id = add('面试怎么样了', '2026-10-30', '2026-10-28T21:00:00')
    expect(() => store.db.prepare("UPDATE follow_up SET what = '别的' WHERE id = ?").run(id)).toThrow(/不能被改写/)
    store.markFollowUp(id, 'done', owner, { outcome: '过了' })
    expect(() => store.db.prepare("UPDATE follow_up SET outcome = '没过' WHERE id = ?").run(id)).toThrow(/不能被改写/)
  })

  it('按可见范围：群里惦记的私聊看不到、标不了', () => {
    const r = store.followUp({ what: '群里的事', askAfter: '2026-10-30' }, { viewer: group, now: at('2026-10-28T21:00:00') })
    expect(r.ok).toBe(true)
    expect(store.openFollowUps(owner)).toHaveLength(0)
    expect(store.markFollowUp((r as { id: string }).id, 'done', owner)).toMatchObject({ ok: false })
  })

  it('惦记的事排在最前面', () => {
    keep({ content: '老大开一辆白色的比亚迪。' }, '2026-10-26T20:00:00')
    add('面试怎么样了', '2026-10-29', '2026-10-28T21:00:00')
    const s = layer('2026-10-29T20:00:00')
    expect(s.indexOf('我惦记着的事')).toBeLessThan(s.indexOf('关于老大'))
    expect(s).toContain('follow_up')
  })

  it('旧库（没有这张表）打开时自动补上，记忆不受影响', () => {
    const id = keep({ content: '老大怕冷。' }, '2026-10-26T20:00:00')
    store.db.exec('DROP TABLE follow_up')
    store.close()
    store = MemoryStore.open(join(dir, 'memory.db'), { ownerName: '老大' })
    expect(store.get(id)?.content).toBe('老大怕冷。')
    expect(store.openFollowUps(owner)).toEqual([])
  })
})

describe('回忆带“多久以前”', () => {
  it('口语说法', () => {
    const now = at('2026-10-29T08:00:00')
    expect(agoText('2026-10-29T01:00:00+08:00', now)).toBe('今天')
    expect(agoText('2026-10-28T23:00:00+08:00', now)).toBe('昨天')
    expect(agoText('2026-10-22T23:00:00+08:00', now)).toBe('7 天前')
    expect(agoText('2026-10-08T23:00:00+08:00', now)).toBe('3 周前')
    expect(agoText('2026-07-29T23:00:00+08:00', now)).toBe('3 个月前')
  })

  it('renderRecall 给了 now 就带上；不给保持原样', () => {
    keep({ content: '老大开一辆白色的比亚迪。' }, '2026-10-08T20:00:00')
    const r = store.recall({ query: '比亚迪' }, owner, at('2026-10-29T08:00:00'))
    expect(renderRecall(r, '比亚迪', at('2026-10-29T08:00:00'))).toContain('2026-10-08 20:00（3 周前）')
    expect(renderRecall(r, '比亚迪')).not.toContain('周前')
  })
})

describe('稳定层：D 日期开关', () => {
  it('开了带 MM-DD，关着和 0.4.0 一样', () => {
    keep({ content: '今天是豆包两岁生日。', kind: '经历' }, '2026-10-18T20:00:00')
    expect(stableLayer(store, owner, at('2026-10-29T08:00:00'), { ownerName: '老大' })).toContain('（11 天前，老大亲口说的）')
    expect(stableLayer(store, owner, at('2026-10-29T08:00:00'), { ownerName: '老大', dates: true })).toContain('（10-18，11 天前，老大亲口说的）')
  })
})

describe('惦记的事不越积越多（10-30 完整档：第 100 天还开着 42 件）', () => {
  const add = (what: string, askAfter: string, now: string) => store.followUp({ what, askAfter }, { viewer: owner, now: at(now) })
  it('同时最多惦记 8 件；标掉一件就又能惦记', () => {
    for (let i = 0; i < 8; i++) expect(add(`第 ${i} 件事`, '2026-11-01', '2026-10-30T20:00:00').ok).toBe(true)
    const r = add('第 9 件事', '2026-11-01', '2026-10-30T20:00:00')
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('先把有结果的') })
    const first = store.openFollowUps(owner)[0]!
    store.markFollowUp(first.id, 'done', owner)
    expect(add('第 9 件事', '2026-11-01', '2026-10-30T20:00:00').ok).toBe(true)
  })
  it('过了放下日子的不占名额', () => {
    for (let i = 0; i < 8; i++) add(`旧事 ${i}`, '2026-10-01', '2026-09-30T20:00:00')
    expect(add('新事', '2026-11-01', '2026-10-30T20:00:00').ok).toBe(true)
  })
  it('稳定层最多列 4 件，到时候的在前', () => {
    for (let i = 0; i < 6; i++) add(`以后的事 ${i}`, '2026-11-20', '2026-10-30T20:00:00')
    add('面试怎么样了', '2026-10-31', '2026-10-30T20:00:00')
    const s = layer('2026-11-01T09:00:00')
    const lines = s.split('\n').filter((l) => l.startsWith('· [f_'))
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('面试')
  })
})
