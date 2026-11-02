// 记忆 v2 读侧：前缀档位 P、每轮预检索 J、代码提醒惦记 K
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hardCue, historyCue, MemoryStore, NOTICE_HEAD, NOTICE_MAX, OWNER_ID, PREFIX_TIERS, renderNotice, stableLayer, stableLayerWithIds,
  type KeepInput, type Viewer,
} from '../src/index.js'

const owner: Viewer = { person: OWNER_ID, channel: 'private' }
const sister: Viewer = { person: 'p_sister', channel: 'private' }
const at = (s: string) => new Date(`${s}+08:00`)
let dir: string
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'v2read-'))
  store = MemoryStore.open(join(dir, 'memory.db'), { ownerName: '老大' })
  store.ensurePerson('p_sister', '小雨')
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})
const keep = (i: Partial<KeepInput> & { content: string }, when = '2026-10-20T20:00:00', v: Viewer = owner) => {
  const r = store.keep({ importance: '一般', about: '对方', kind: '事实', ...i }, { viewer: v, now: at(when) })
  if (!r.ok) throw new Error(r.reason)
  return r.id
}
const NOW = at('2026-10-30T09:00:00')
// 单测的库只有十几条，bm25 分数比校准用的 180 条库低得多（IDF 随库大小变）：这里测机制，用小库的门槛
const SMALL = { cue: 1.0, soft: 2.0, hi: 3.0, delta: 0.8 }
const nameOf = (id: string | null) => store.nameOf(id)

describe('线索判断', () => {
  it('明确在问以前的事 / 身份信息 / 提到认识的人 = strong；问自己的事的问句 = soft；闲聊 = none', () => {
    expect(hardCue('你还记得我生日吗')).toBe('strong')
    expect(hardCue('我对什么过敏来着')).toBe('strong')
    expect(hardCue('小雨最近怎么样', ['小雨'])).toBe('strong')
    expect(hardCue('我那只猫你觉得可爱吗？')).toBe('soft')
    expect(hardCue('今天好热啊')).toBe('none')
    expect(historyCue('我以前住哪来着')).toBe(true)
    expect(historyCue('我现在住哪')).toBe(false)
  })
})

describe('开关 J：每轮预检索', () => {
  const fill = () => {
    for (let i = 0; i < 12; i++) keep({ content: `老大说今天第${i}次加班到很晚，好累。` }, `2026-10-${String(10 + i).padStart(2, '0')}T20:00:00`)
  }

  it('强线索 + 命中 → 注入；只写 last_surfaced 和 recall_log(inject)，不加强记忆', () => {
    fill()
    const id = keep({ content: '老大对芒果过敏，吃了会起疹子。' })
    const r = store.preRecall('我对什么过敏来着？', owner, NOW, { gate: SMALL, cue: hardCue('我对什么过敏来着？') })
    expect(r.injected).toBe(true)
    expect(r.items[0]!.row.id).toBe(id)
    const row = store.db.prepare('SELECT recall_count, last_recalled, last_surfaced FROM memory WHERE id = ?').get(id) as { recall_count: number; last_recalled: string | null; last_surfaced: string | null }
    expect(row.recall_count).toBe(0)
    expect(row.last_recalled).toBeNull()
    expect(row.last_surfaced).not.toBeNull()
    const log = store.db.prepare("SELECT * FROM recall_log WHERE channel = 'inject'").all()
    expect(log).toHaveLength(1)
  })

  it('闲聊、没命中、全是常见词 → 不注入；dryRun 不留痕', () => {
    fill()
    keep({ content: '老大对芒果过敏，吃了会起疹子。' })
    expect(store.preRecall('今天天气不错', owner, NOW, { gate: SMALL, cue: 'none' }).injected).toBe(false)
    expect(store.preRecall('哈哈哈', owner, NOW, { gate: SMALL, cue: 'none' }).injected).toBe(false)
    const r = store.preRecall('我对什么过敏来着？', owner, NOW, { gate: SMALL, cue: 'strong', dryRun: true })
    expect(r.injected).toBe(true)
    expect(store.db.prepare("SELECT count(*) AS n FROM recall_log WHERE channel = 'inject'").get()).toEqual({ n: 0 })
  })

  it('候选排除：前缀已列 / 最近注入过 / 被替代 / 别人可见范围 / 模糊', () => {
    fill()
    const a = keep({ content: '老大对芒果过敏。' })
    expect(store.preRecall('我芒果过敏吗', owner, NOW, { gate: SMALL, cue: 'strong', exclude: new Set([a]) }).injected).toBe(false)
    // 被替代：只给新的
    const b = keep({ content: '老大住在深圳。' }, '2026-09-01T20:00:00')
    const c = keep({ content: '老大搬到杭州了，住在西湖边。', supersedes: b }, '2026-10-01T20:00:00')
    const r = store.preRecall('我住在哪个城市来着', owner, NOW, { gate: SMALL, cue: 'strong' })
    expect(r.items.map((x) => x.row.id)).toContain(c)
    expect(r.items.map((x) => x.row.id)).not.toContain(b)
    // 妹妹那册的事，老大的对话里想不起来
    keep({ content: '小雨在准备考研。' }, '2026-10-20T20:00:00', sister)
    expect(store.preRecall('小雨在准备考研吗', owner, NOW, { gate: SMALL, cue: 'strong' }).items.some((x) => x.row.content.includes('考研'))).toBe(false)
    // 模糊（小事、两年前）不进候选
    keep({ content: '老大喜欢吃榴莲。', importance: '小事' }, '2024-10-01T20:00:00')
    expect(store.preRecall('我喜欢吃榴莲吗', owner, NOW, { gate: SMALL, cue: 'strong' }).items.some((x) => x.row.content.includes('榴莲'))).toBe(false)
  })

  it('问“以前”时带上替代链上的旧条（最多 2 层）；不问就不带', () => {
    fill()
    const a = keep({ content: '老大住在苏州。' }, '2026-08-01T20:00:00')
    const b = keep({ content: '老大住在深圳。', supersedes: a }, '2026-09-01T20:00:00')
    keep({ content: '老大住在杭州。', supersedes: b }, '2026-10-01T20:00:00')
    const r = store.preRecall('我以前住在哪', owner, NOW, { gate: SMALL, cue: 'strong', history: historyCue('我以前住在哪') })
    expect(r.items[0]!.older.map((x) => x.text)).toEqual(['老大住在深圳。', '老大住在苏州。'])
    expect(store.preRecall('我住在哪', owner, NOW, { gate: SMALL, cue: 'strong', history: false }).items[0]!.older).toEqual([])
  })

  it('最多 k 条；渲染：开头声明不是指令、带出处与多久以前、总长有上限', () => {
    fill()
    for (let i = 0; i < 6; i++) keep({ content: `老大的猫叫豆包，第${i}件关于猫的事：${'很'.repeat(60)}可爱。` })
    const r = store.preRecall('我家猫叫什么来着', owner, NOW, { cue: 'strong', k: 3, gate: { cue: 0 } })
    expect(r.items).toHaveLength(3)
    const t = renderNotice({ recall: r, now: NOW, nameOf, recallChars: 150 })
    expect(t.startsWith(NOTICE_HEAD)).toBe(true)
    expect(t).toContain('老大亲口说的')
    expect(t).toContain('天前')
    expect([...t].length).toBeLessThanOrEqual(NOTICE_MAX)
    expect(t.split('\n').filter((l) => l.startsWith('· ')).length).toBeLessThan(3)
    expect(renderNotice({ now: NOW, nameOf })).toBe('')
  })
})

describe('开关 K：到日子由代码提醒', () => {
  const fu = (what: string, askAfter: string, keys?: string[], when = '2026-10-20T20:00:00') => {
    const r = store.followUp({ what, askAfter, ...(keys ? { keys } : {}) }, { viewer: owner, now: at(when) })
    if (!r.ok) throw new Error(r.reason)
    return r.id
  }

  it('到时候了 → 提醒一次；同一天不再提醒；最多连着 2 天；不替她标“问过了”', () => {
    const id = fu('老大周三面试，问问结果', '2026-10-29')
    expect(store.followUpNotice(owner, '在吗', at('2026-10-29T10:00:00'))?.row.id).toBe(id)
    expect(store.followUpNotice(owner, '在吗', at('2026-10-29T15:00:00'))).toBeUndefined()
    expect(store.followUpNotice(owner, '在吗', at('2026-10-30T10:00:00'))?.why).toBe('due')
    expect(store.followUpNotice(owner, '在吗', at('2026-10-31T10:00:00'))).toBeUndefined()
    const row = store.db.prepare('SELECT asked_count, notice_count FROM follow_up WHERE id = ?').get(id) as { asked_count: number; notice_count: number }
    expect(row).toEqual({ asked_count: 0, notice_count: 2 })
  })

  it('还没到时候，但对方说到了触发词 → 提醒“好像说到了”；没说到不提醒', () => {
    fu('老大考驾照科目二，问问过没过', '2026-11-20', ['科目二', '驾照'])
    expect(store.followUpNotice(owner, '今天天气好', NOW)).toBeUndefined()
    const n = store.followUpNotice(owner, '我今天去考科目二了！', NOW)
    expect(n?.why).toBe('key')
    expect(renderNotice({ follow: n!, now: NOW, nameOf })).toContain('【对方好像说到了我惦记的事】')
  })

  it('触发词校验：最多 5 个、每个最多 10 字', () => {
    expect(store.followUp({ what: 'x', askAfter: '2026-11-01', keys: ['a', 'b', 'c', 'd', 'e', 'f'] }, { viewer: owner, now: NOW }).ok).toBe(false)
    expect(store.followUp({ what: 'x', askAfter: '2026-11-01', keys: ['一二三四五六七八九十一'] }, { viewer: owner, now: NOW }).ok).toBe(false)
  })

  it('只提醒当前对话看得到的', () => {
    store.followUp({ what: '小雨考研成绩出来没', askAfter: '2026-10-29' }, { viewer: sister, now: at('2026-10-20T20:00:00') })
    expect(store.followUpNotice(owner, '在吗', NOW)).toBeUndefined()
    expect(store.followUpNotice(sister, '在吗', NOW)?.row.what).toBe('小雨考研成绩出来没')
  })
})

describe('开关 P：前缀档位；K 开时惦记只报件数', () => {
  it('默认参数输出不变（stableLayer === stableLayerWithIds.text）；ids 是实际列出的条目', () => {
    const ids = [keep({ content: '老大开白色比亚迪。' }), keep({ content: '老大喜欢陈奕迅。' })]
    const a = stableLayer(store, owner, NOW, { ownerName: '老大' })
    const b = stableLayerWithIds(store, owner, NOW, { ownerName: '老大' })
    expect(b.text).toBe(a)
    expect(new Set(b.ids)).toEqual(new Set(ids))
  })

  it('P100 比 P46 列得多；P46 档等于默认', () => {
    for (let i = 0; i < 40; i++) keep({ content: `老大的第${i}件事。` })
    const p46 = stableLayerWithIds(store, owner, NOW, { ownerName: '老大', ...PREFIX_TIERS.P46 })
    const p100 = stableLayerWithIds(store, owner, NOW, { ownerName: '老大', ...PREFIX_TIERS.P100 })
    expect(p46.ids).toHaveLength(24)
    expect(p100.ids).toHaveLength(40)
    expect(p46.text).toBe(stableLayer(store, owner, NOW, { ownerName: '老大' }))
  })

  it('followUps=count：不列清单，只说还惦记着几件', () => {
    store.followUp({ what: '面试结果', askAfter: '2026-10-29' }, { viewer: owner, now: at('2026-10-20T20:00:00') })
    store.followUp({ what: '体检报告', askAfter: '2026-11-05' }, { viewer: owner, now: at('2026-10-20T20:00:00') })
    const s = stableLayer(store, owner, NOW, { ownerName: '老大', followUps: 'count' })
    expect(s).toContain('心里还惦记着 2 件事')
    expect(s).not.toContain('面试结果')
    expect(s).not.toContain('follow_up 标一下')
  })
})

describe('兼容：旧库照常打开，新列补上；旧插件写入的行照常读', () => {
  it('没有新列的 follow_up / memory 打开后补列，默认值正确', () => {
    store.close()
    const db = new DatabaseSync(join(dir, 'memory.db'))
    // 模拟 0.5.1 建的库：删掉新列所在的表再按旧结构建（只测 follow_up；memory 的新列是可空列）
    db.exec('DROP TABLE follow_up')
    db.exec(`CREATE TABLE follow_up (id TEXT PRIMARY KEY, person TEXT NOT NULL, what TEXT NOT NULL, what_sha TEXT NOT NULL, ask_after TEXT NOT NULL, give_up_after TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', asked_count INTEGER NOT NULL DEFAULT 0, last_asked TEXT, outcome TEXT, visibility TEXT NOT NULL, written_in TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT)`)
    db.exec("INSERT INTO follow_up (id, person, what, what_sha, ask_after, give_up_after, visibility, written_in, created_at) VALUES ('f_old', 'p_owner', '旧的一件事', 'x', '2026-10-29', '2026-11-05', 'person:p_owner', 'day', '2026-10-20T20:00:00+08:00')")
    db.close()
    store = MemoryStore.open(join(dir, 'memory.db'), { ownerName: '老大' })
    const row = store.openFollowUps(owner)[0]!
    expect(row.trigger_keys).toBe('[]')
    expect(row.notice_count).toBe(0)
    expect(store.followUpNotice(owner, '在吗', NOW)?.row.id).toBe('f_old')
    store.setKv('compaction_gen', '3')
    expect(store.getKv('compaction_gen')).toBe('3')
  })
})
