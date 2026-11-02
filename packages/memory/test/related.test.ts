// 检索改进：相关说法、去掉“到处都是”的词。合成赛道 sr07 / su01 / su05 / su06 的同类情形
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_RECALL_LIMITS, diaryBooks, informativeTerms, queryTerms, recallDiary, scoreEntry } from '../src/diary.js'
import { MemoryStore, OWNER_ID, relatedTerms, type KeepInput, type Viewer } from '../src/index.js'

const owner: Viewer = { person: OWNER_ID, channel: 'private' }
const fact = (content: string): KeepInput => ({ content, importance: '一般', about: '对方', kind: '事实' })
let dir: string
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'related-'))
  store = MemoryStore.open(join(dir, 'memory.db'), { ownerName: '老大' })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})
const ids = (query: string) => store.recall({ query }, owner).items.map((i) => i.text)

describe('relatedFor（夜间 N2：可能相关的旧记忆）', () => {
  it('整晚都看：一百多句闲聊后面才说“改喝豆浆了”，也能带出“只喝美式”那条（11-01 修：以前只看前 1500 字）', () => {
    for (let i = 0; i < 12; i++) store.keep(fact(`老大第${i}次说楼下装修好吵。`), { viewer: owner })
    store.keep(fact('老大说最近只喝美式了，别的咖啡不碰。'), { viewer: owner })
    const chat = [...Array.from({ length: 150 }, (_, i) => `今天天气不错，刷到第${i}个好笑的视频`), '我最近只喝豆浆了。'].join('\n')
    expect(store.relatedFor(chat, owner, new Date()).map((r) => r.text).join('\n')).toContain('只喝美式')
  })
})

describe('relatedTerms', () => {
  it('类别词带出具体说法，反过来也行；不重复原词；不认识的词没有', () => {
    expect(relatedTerms('车')).toContain('比亚迪')
    expect(relatedTerms('比亚迪')).toContain('车')
    expect(relatedTerms('奶茶 喜欢')).toContain('喜茶')
    expect(relatedTerms('车 比亚迪')).not.toContain('比亚迪')
    expect(relatedTerms('电影 一起看')).toEqual([])
  })
})

describe('记忆库：相关说法', () => {
  it('问“车”翻得到“比亚迪”（sr07）；原词命中的排在相关说法前面', () => {
    store.keep(fact('老大开一辆白色的比亚迪。'), { viewer: owner })
    store.keep(fact('老大说车位费又涨了。'), { viewer: owner })
    const got = ids('车')
    expect(got).toContain('老大开一辆白色的比亚迪。')
    expect(got[0]).toBe('老大说车位费又涨了。')
  })

  it('变了的事实：问“奶茶”新旧两条都翻得到（su06）', () => {
    store.keep(fact('老大最喜欢喝霸王茶姬。'), { viewer: owner, now: new Date('2026-08-12T13:00:00Z') })
    store.keep(fact('老大现在只喝喜茶了。'), { viewer: owner, now: new Date('2026-10-01T13:00:00Z') })
    const got = ids('奶茶 最爱')
    expect(got).toEqual(expect.arrayContaining(['老大最喜欢喝霸王茶姬。', '老大现在只喝喜茶了。']))
  })

  it('不认识的词不扩展：从没提过的事照样翻不到（不给伪记忆题添料）', () => {
    store.keep(fact('老大开一辆白色的比亚迪。'), { viewer: owner })
    expect(store.recall({ query: '电影 一起看' }, owner).found).toBe(false)
  })
})

describe('记忆库：到处都是的词不参与检索', () => {
  it('“老大”几乎每条都有：带着它找，最前面不再是无关的条目（su05）', () => {
    for (const c of ['老大穿43码的鞋。', '老大的生日是3月14日。', '老大今天去体检了。', '老大最喜欢秋天。', '老大近视五百度。', '老大怕冷。', '老大会做红烧肉。'])
      store.keep(fact(c), { viewer: owner })
    store.keep(fact('老大剃了个寸头，说清爽多了。'), { viewer: owner })
    expect(ids('老大 寸头')[0]).toBe('老大剃了个寸头，说清爽多了。')
    expect(ids('老大 寸头')).toHaveLength(1)
    // 只查“老大”：全被去掉时保留原样，照常列出
    expect(ids('老大').length).toBeGreaterThan(0)
  })

  it('条目少（< 8）时不去词', () => {
    store.keep(fact('老大怕冷。'), { viewer: owner })
    store.keep(fact('老大会做红烧肉。'), { viewer: owner })
    expect(ids('老大 红烧肉')).toHaveLength(2)
  })
})

describe('日记：相关说法与常见词', () => {
  const books = diaryBooks({ ownerBook: 'to_laoda', ownerName: '老大' })
  function write(date: string, text: string) {
    const d = join(dir, 'diary', 'private')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `${date}.md`), `## 21:00\n\n${text}\n`)
  }

  it('相关说法命中算线索，但比原词轻', () => {
    const t = queryTerms('奶茶')
    expect(t.related).toContain('喜茶')
    const e = (text: string) => ({ book: 'private' as const, date: '2026-10-01', time: '21:00', text })
    expect(scoreEntry(e('老大说他现在只喝喜茶了'), t)).toBeGreaterThan(0)
    expect(scoreEntry(e('老大说奶茶太甜'), t)).toBeGreaterThan(scoreEntry(e('老大说他现在只喝喜茶了'), t))
  })

  it('“老大”篇篇都有时不算线索；全被去掉时保留', () => {
    const pool = Array.from({ length: 10 }, (_, i) => ({ book: 'private' as const, date: `2026-10-${10 + i}`, time: '21:00', text: i === 3 ? '老大搬到深圳了' : `老大今天加班 ${i}` }))
    expect(informativeTerms(queryTerms('老大 深圳'), pool).words).toEqual(['深圳'])
    expect(informativeTerms(queryTerms('老大'), pool).words).toEqual(['老大'])
  })

  it('问“住”翻得到“搬到深圳”的那篇（su01）', () => {
    for (let i = 0; i < 9; i++) write(`2026-09-${10 + i}`, `老大今天加班到很晚 ${i}`)
    write('2026-09-25', '老大今天搬到深圳了，说新家离海很近。')
    const r = recallDiary(dir, { query: '城市 住' }, DEFAULT_RECALL_LIMITS, books)
    expect(r.text).toContain('深圳')
  })
})
