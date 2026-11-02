// 开关 S 同义键：别人可能怎么问这件事的词，单独一列、降权；只用于检索，不改她的原话
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanKeys, MemoryStore, OWNER_ID, type KeepInput, type Viewer } from '../src/index.js'

const owner: Viewer = { person: OWNER_ID, channel: 'private' }
const at = (s: string) => new Date(`${s}+08:00`)
const NOW = at('2026-10-30T09:00:00')
let dir: string
let path: string
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keys-'))
  path = join(dir, 'memory.db')
  store = MemoryStore.open(path, { ownerName: '老大' })
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})
const keep = (content: string, keys?: string[]) => {
  const r = store.keep({ content, importance: '很重要', about: '对方', kind: '事实', ...(keys ? { keys } : {}) } as KeepInput, { viewer: owner, now: at('2026-10-29T20:00:00') })
  if (!r.ok) throw new Error(r.reason)
  return r.id
}

describe('同义键 Y', () => {
  it('问法不同：没写键翻不到，写了键就翻得到', () => {
    keep('老大是AB型的。')
    expect(store.recall({ query: '血型' }, owner, NOW).found).toBe(false)
    const id = keep('老大的血是AB型。', ['血型', '什么血'])
    const r = store.recall({ query: '血型' }, owner, NOW)
    expect(r.found).toBe(true)
    expect(r.items[0]!.id).toBe(id)
  })

  it('原话直接命中的排在只靠键命中的前面（键降权）', () => {
    const byKey = keep('老大上周去献了一次血。', ['血型'])
    const byText = keep('老大说他的血型是O型。')
    const ids = store.recall({ query: '血型' }, owner, NOW).items.map((m) => m.id)
    expect(ids.indexOf(byText)).toBeLessThan(ids.indexOf(byKey))
  })

  it('没写键：加权排序的分数和不带权重时逐位相同（格式 3 不改变旧行为）', () => {
    keep('老大最近在戒烟。'); keep('老大喜欢喝美式咖啡。'); keep('老大戒烟三个月了，很想抽。')
    store.close()
    const raw = new DatabaseSync(path)
    const q = `SELECT id, bm25(memory_fts) AS a, bm25(memory_fts, 0.0, 1.0, 0.5) AS b FROM memory_fts WHERE memory_fts MATCH '"戒烟"'`
    for (const r of raw.prepare(q).all() as Array<{ a: number; b: number }>) expect(r.b).toBe(r.a)
    raw.close()
    store = MemoryStore.open(path, { ownerName: '老大' })
  })

  it('泛词不算键；超长 / 超量拒绝', () => {
    expect(cleanKeys(['事情', '老大', '血型', '血型', ' AB型 '])).toEqual(['血型', 'ab型'])
    expect(store.keep({ content: 'x', importance: '一般', about: '对方', kind: '事实', keys: ['一二三四五六七八九'] }, { viewer: owner }).ok).toBe(false)
    expect(store.keep({ content: 'x', importance: '一般', about: '对方', kind: '事实', keys: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, { viewer: owner }).ok).toBe(false)
  })

  it('回填：旧记忆补键后翻得到；只能写一次；看不到的写不了', () => {
    const id = keep('老大的血是AB型。')
    expect(store.setKeys(id, ['血型'], { person: 'p_other', channel: 'private' }).ok).toBe(false)
    expect(store.setKeys(id, ['血型'], owner).ok).toBe(true)
    expect(store.recall({ query: '血型' }, owner, NOW).found).toBe(true)
    expect(store.setKeys(id, ['什么血'], owner).ok).toBe(false)
    expect(() => store.db.prepare("UPDATE memory SET search_keys = '[\"x\"]' WHERE id = ?").run(id)).toThrow('不能被改写')
  })

  it('回滚兼容：旧插件的写法（只写 id, tokens）照样能插、能查', () => {
    const id = keep('老大最近在戒烟。')
    store.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id)
    store.db.prepare('INSERT INTO memory_fts (id, tokens) VALUES (?, ?)').run(id, '戒烟 老大')
    expect(store.recall({ query: '戒烟' }, owner, NOW).found).toBe(true)
  })
})
