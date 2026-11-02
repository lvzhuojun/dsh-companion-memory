import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_RECALL_LIMITS, diaryBooks, loadDiary, parseDiaryFile, queryTerms, recallDiary, scoreEntry, type RecallDiaryQuery } from '../src/diary.js'

// 自定义配置示例：给老大的那本是 to_laoda（目录 to-laoda）
const books = diaryBooks({ ownerBook: 'to_laoda', ownerName: '老大' })
const recall = (dir: string, q: RecallDiaryQuery) => recallDiary(dir, q, DEFAULT_RECALL_LIMITS, books)

let life: string

function write(book: 'to-laoda' | 'private', date: string, body: string) {
  const dir = join(life, 'diary', book)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${date}.md`), body)
}

beforeEach(() => {
  life = mkdtempSync(join(tmpdir(), 'diary-'))
})
afterEach(() => {
  rmSync(life, { recursive: true, force: true })
})

describe('parseDiaryFile', () => {
  it('按 “## HH:MM” 切篇，保留时间', () => {
    const entries = parseDiaryFile('\n## 09:05\n\n早上好\n\n## 21:30\n\n今天下雨了。\n第二行\n', 'private', '2026-10-20')
    expect(entries).toEqual([
      { book: 'private', date: '2026-10-20', time: '09:05', text: '早上好' },
      { book: 'private', date: '2026-10-20', time: '21:30', text: '今天下雨了。\n第二行' },
    ])
  })

  it('没有标题的内容也算一篇，时间为空', () => {
    expect(parseDiaryFile('随手写的', 'to_laoda', '2026-10-20')).toEqual([
      { book: 'to_laoda', date: '2026-10-20', time: '', text: '随手写的' },
    ])
  })

  it('兼容 CRLF 与一位数小时', () => {
    expect(parseDiaryFile('## 9:05\r\n\r\n早', 'private', '2026-10-20')[0]?.time).toBe('09:05')
  })
})

describe('loadDiary', () => {
  it('两本日记按日期时间合并排序，忽略非日期文件', () => {
    write('private', '2026-10-21', '## 08:00\n\n第二天')
    write('to-laoda', '2026-10-20', '## 22:00\n\n第一天晚上')
    write('private', '2026-10-20', '## 07:00\n\n第一天早上')
    writeFileSync(join(life, 'diary', 'private', 'notes.txt'), '不是日记')
    expect(loadDiary(life, books).map((e) => e.text)).toEqual(['第一天早上', '第一天晚上', '第二天'])
  })

  it('目录不存在时返回空', () => {
    expect(loadDiary(join(life, 'nope'))).toEqual([])
  })
})

describe('queryTerms / scoreEntry', () => {
  const entry = { book: 'private' as const, date: '2026-10-20', time: '21:00', text: '老大说他最喜欢橘猫，小时候养过一只。' }

  it('关键词命中', () => {
    expect(scoreEntry(entry, queryTerms('橘猫'))).toBeGreaterThan(0)
  })

  it('整句口语提问也能靠两字切片命中', () => {
    expect(scoreEntry(entry, queryTerms('你还记得老大喜欢什么猫吗'))).toBeGreaterThan(0)
  })

  it('无关的事不命中', () => {
    expect(scoreEntry(entry, queryTerms('面试 结果'))).toBe(0)
  })

  it('只有语气词和“记得/上次”这类词时没有线索', () => {
    expect(queryTerms('上次 记得 吗')).toEqual({ words: [], bigrams: [], related: [] })
  })
})

describe('recallDiary', () => {
  beforeEach(() => {
    write('to-laoda', '2026-10-20', '## 21:00\n\n老大今天面试回来很累，我陪他聊到很晚。')
    write('private', '2026-10-20', '## 23:10\n\n我其实有点担心他。')
    write('private', '2026-10-22', '## 10:00\n\n今天下雨，我喜欢下雨天的声音。')
  })

  it('按日期翻', () => {
    const r = recall(life, { date: '2026-10-20' })
    expect(r.found).toBe(true)
    expect(r.entries).toHaveLength(2)
    expect(r.text).toContain('【给老大的日记 · 2026-10-20 21:00】')
    expect(r.text).toContain('【私人日记 · 2026-10-20 23:10】')
  })

  it('按月翻', () => {
    expect(recall(life, { month: '2026-10' }).entries).toHaveLength(3)
  })

  it('按事情找', () => {
    const r = recall(life, { query: '下雨' })
    expect(r.found).toBe(true)
    expect(r.entries.map((e) => e.date)).toEqual(['2026-10-22'])
  })

  it('只翻一本', () => {
    expect(recall(life, { date: '2026-10-20', book: 'private' }).entries).toHaveLength(1)
  })

  it('找不到时明确说没找到，并提醒不要编', () => {
    const r = recall(life, { query: '生日礼物' })
    expect(r.found).toBe(false)
    expect(r.text).toContain('没找到')
    expect(r.text).toContain('不要编')
  })

  it('那天没写日记', () => {
    const r = recall(life, { date: '2026-10-21' })
    expect(r.found).toBe(false)
    expect(r.text).toContain('2026-10-21 这天没有写过日记')
  })

  it('什么都不给时列出最近写过日记的日子，不带正文', () => {
    const r = recall(life, {})
    expect(r.text).toContain('2026-10-22：私人日记 1 篇')
    expect(r.text).toContain('2026-10-20：给老大的日记 1 篇，私人日记 1 篇')
    expect(r.text).not.toContain('下雨')
  })

  it('日期格式错误时给出提示', () => {
    expect(recall(life, { date: '10月20日' }).text).toContain('YYYY-MM-DD')
  })

  it('空日记本', () => {
    const empty = mkdtempSync(join(tmpdir(), 'diary-empty-'))
    try {
      expect(recall(empty, { query: '猫' })).toMatchObject({ found: false })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('第九节：正文原样给出，一字不改', () => {
    const body = '今天……嗯。\n\n  老大说“别担心”，可我还是担心。  \n（写给自己）'
    write('private', '2026-10-24', `## 08:00\n\n${body}\n`)
    const r = recall(life, { date: '2026-10-24' })
    expect(r.text).toBe(`【私人日记 · 2026-10-24 08:00】\n${body.trim()}`)
  })

  it('长日记整篇给出，不在中间截断', () => {
    const long = '很长'.repeat(1900) // 3800 字，超过单次额度
    write('private', '2026-10-23', '## 10:00\n\n' + long)
    const r = recall(life, { date: '2026-10-23' })
    expect(r.text).toContain(long)
    expect(r.text).not.toContain('…')
  })

  it('放不下的篇只列日期时间，可以再按 date + time 翻那一篇', () => {
    write('private', '2026-10-25', `## 08:00\n\n${'早'.repeat(2000)}\n\n## 20:00\n\n${'晚'.repeat(2000)}`)
    const r = recall(life, { date: '2026-10-25' })
    expect(r.text).toContain('早'.repeat(2000))
    expect(r.text).not.toContain('晚晚')
    expect(r.text).toContain('还有 1 篇这次放不下')
    expect(r.text).toContain('私人日记 · 2026-10-25 20:00')
    const one = recall(life, { date: '2026-10-25', time: '20:00' })
    expect(one.text).toContain('晚'.repeat(2000))
  })

  it('time 必须和 date 一起用', () => {
    expect(recall(life, { time: '20:00' }).text).toContain('和 date 一起用')
  })
})

describe('日记本命名可配置（决定 N-4）', () => {
  it('通用默认：给主人的本子 to_owner，目录 to-owner', () => {
    const d = diaryBooks()
    expect(d.ids).toEqual(['to_owner', 'private'])
    expect(d.dir('to_owner')).toBe('to-owner')
    expect(d.label('to_owner')).toBe('给主人的日记')
  })

  it('自定义配置：to_laoda → 目录 to-laoda、“给老大的日记”，已有日记不用迁移', () => {
    expect(books.dir('to_laoda')).toBe('to-laoda')
    expect(books.label('to_laoda')).toBe('给老大的日记')
    expect(books.label('private')).toBe('私人日记')
  })

  it('不合法的配置在启动时就报错', () => {
    for (const ownerBook of ['private', '../x', 'To_Owner', '']) expect(() => diaryBooks({ ownerBook, ownerName: '主人' })).toThrow('ownerBook')
    expect(() => diaryBooks({ ownerBook: 'to_owner', ownerName: '  ' })).toThrow('ownerName')
  })

  it('不认识的本子名翻不到东西，也不会拼出别的目录', () => {
    expect(recall(tmpdir(), { book: '../../etc' }).found).toBe(false)
  })
})
