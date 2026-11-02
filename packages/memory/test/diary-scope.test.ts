// 日记按语境隔离
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_RECALL_LIMITS, diaryBooks, diaryScope, loadDiary, loadDiaryFor, othersHint, recallDiary } from '../src/index.js'

const books = diaryBooks({ ownerBook: 'to_laoda', ownerName: '老大' })
const owner = { person: 'p_owner', channel: 'private' }
const friend = { person: 'p_friend', channel: 'private' }
let life: string
beforeEach(() => { life = mkdtempSync(join(tmpdir(), 'diary-scope-')) })
afterEach(() => { rmSync(life, { recursive: true, force: true }) })
const put = (rel: string, date: string, text: string) => {
  const dir = join(life, 'diary', rel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${date}.md`), `## 21:00\n\n${text}\n`)
}

describe('日记按语境隔离', () => {
  it('主人语境两本、原位置；别人语境只有私人的、在 private/@id/；群聊不翻不写；id 不合法就报错', () => {
    const o = diaryScope(owner, books, 'p_owner')
    expect(o.readable).toEqual(['to_laoda', 'private'])
    expect(o.dir('private')).toBe('private')
    expect(o.writable('to_laoda')).toBe(true)
    const f = diaryScope(friend, books, 'p_owner')
    expect(f.readable).toEqual(['private'])
    expect(f.dir('private')).toBe('private/@p_friend')
    expect(f.writable('to_laoda')).toContain('私人日记')
    expect(f.writable('private')).toBe(true)
    expect(diaryScope({ person: 'p_owner', channel: 'group:g1' }, books, 'p_owner').readable).toEqual([])
    expect(() => diaryScope({ person: '../x', channel: 'private' }, books, 'p_owner')).toThrow()
  })

  it('读：主人语境不进子目录（旧插件同样，回滚安全），别人语境只读自己的格', () => {
    put('private', '2026-11-01', '老大的事')
    put('private/@p_friend', '2026-11-01', '阿杰的事')
    put('private/@p_sister', '2026-11-01', '小雨的事')
    expect(loadDiary(life, books).map((e) => e.text)).toEqual(['老大的事'])
    expect(loadDiaryFor(life, books, diaryScope(owner, books, 'p_owner')).map((e) => e.text)).toEqual(['老大的事'])
    expect(loadDiaryFor(life, books, diaryScope(friend, books, 'p_owner')).map((e) => e.text)).toEqual(['阿杰的事'])
    expect(recallDiary(life, { query: '小雨' }, DEFAULT_RECALL_LIMITS, books, diaryScope(friend, books, 'p_owner')).found).toBe(false)
  })

  it('隐私引导：只看问题里有没有别人的名字，和库里有没有无关', () => {
    const people = [{ id: 'p_owner', name: '老大' }, { id: 'p_friend', name: '阿杰' }]
    expect(othersHint('阿杰最近怎么样', owner, people)).toContain('阿杰单独跟我聊的事不会出现在这里')
    expect(othersHint('阿杰最近怎么样', friend, people)).toBe('')
    expect(othersHint('今天吃什么', owner, people)).toBe('')
  })
})
