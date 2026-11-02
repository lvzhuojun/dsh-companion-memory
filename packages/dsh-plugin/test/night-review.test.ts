import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diaryBooks, MemoryStore, parseSessionLog, type SessionLog } from '@dsh-companion/memory'
import { chunkLines, dayTranscript, estimateCost, inWindow, reviewDay, reviewPrompt, runNightReview, unwrapQQ, type ReviewBlock, type ReviewModel } from '../src/index.js'

// 一天的会话日志（形状同 rc.2：{type, seq, time, data}；time 是毫秒）
const T = (hhmm: string) => Date.parse(`2026-11-20T${hhmm}:00+08:00`)
const qq = (seq: number, hhmm: string, text: string) => ({ type: 'user/message', seq, time: T(hhmm), data: { content: [{ type: 'text', text: `[QQ · 私聊] 老大：${text}` }], source: { kind: 'plugin:dsh-qq-bridge' }, role: 'user' } })
const tc = (seq: number, hhmm: string) => ({ type: 'user/message', seq, time: T(hhmm), data: { content: [{ type: 'text', text: 'Time sampled while preparing turn 3, step 1: …' }], source: { kind: 'time-context' }, role: 'user' } })
const me = (seq: number, hhmm: string, text: string) => ({ type: 'assistant/message', seq, time: T(hhmm), data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '（思考：不该出现在材料里）' }, { type: 'text', text }] } } })
const sys = { type: 'system/message', seq: 1, time: T('08:00'), data: { message: { content: [{ type: 'text', text: '她的系统提示' }] } } }

function dayLog(): SessionLog {
  const evs = [
    sys,
    qq(2, '08:30', '昨天的事'), // 前一天之前的游标会挡住它（测试里 since 设在 09:00）
    tc(3, '09:10'),
    qq(4, '09:10', '我今天面试，有点紧张'),
    me(5, '09:10', '别紧张，你准备得很充分了！'),
    { type: 'tool/call', seq: 6, time: T('09:11'), data: { name: 'qq_bridge_sticker', arguments: '{}' } },
    qq(7, '20:00', '面试过了！下周一入职'),
    me(8, '20:00', '太好了！恭喜老大！'),
  ]
  return parseSessionLog(Buffer.from(evs.map((e) => JSON.stringify(e)).join('\n') + '\n'))
}

let life: string
let store: MemoryStore
const books = diaryBooks({ ownerBook: 'to_laoda', ownerName: '老大' })
beforeEach(() => {
  life = mkdtempSync(join(tmpdir(), 'night-'))
  store = MemoryStore.open(join(life, 'memory.db'), { ownerName: '老大' })
})
afterEach(() => {
  store.close()
  rmSync(life, { recursive: true, force: true })
})

const base = () => ({
  log: dayLog(), sessionId: 'sess-1', store, lifeDir: life, books, ownerName: '老大', privateDiaryAudited: true,
  since: new Date(T('09:00')), day: '2026-11-20', budget: 0.8, now: () => new Date(T('23:59') + 3600e3),
})

/** 假模型：第一步按 plan 调工具，之后说“好了”；记下每次看到的提示 */
function fakeModel(plan: Array<{ name: string; input: unknown }>, usage = { input_tokens: 1000, output_tokens: 200 }) {
  const seen: Array<{ system: string; prompt: string }> = []
  const model: ReviewModel = {
    async complete({ system, messages }) {
      const first = messages[0]!.content as string
      if (messages.length === 1) {
        seen.push({ system, prompt: first })
        return { content: plan.map((p, i): ReviewBlock => ({ type: 'tool_use', id: `t${i}`, name: p.name, input: p.input })), usage }
      }
      return { content: [{ type: 'text', text: '好了' }], usage }
    },
  }
  return { model, seen }
}

describe('夜间回顾：材料', () => {
  it('去掉 QQ 包装；“怎么回”提示也去掉', () => {
    expect(unwrapQQ('[QQ · 私聊] 老大：在吗')).toBe('在吗')
    expect(unwrapQQ('[QQ · 群 123] 小王：hi\n（回 QQ 用 [QQ]…[/QQ]）')).toBe('hi')
    expect(unwrapQQ('没有包装的话')).toBe('没有包装的话')
  })

  it('只留真人说的话和她说出口的话：剔除系统注入、思考、工具细节；按游标和起始时刻截断', () => {
    const lines = dayTranscript(dayLog(), -1, T('09:00'))
    expect(lines.map((l) => [l.seq, l.who, l.text])).toEqual([
      [4, 'person', '我今天面试，有点紧张'],
      [5, 'me', '别紧张，你准备得很充分了！'],
      [7, 'person', '面试过了！下周一入职'],
      [8, 'me', '太好了！恭喜老大！'],
    ])
    expect(dayTranscript(dayLog(), 5, T('09:00')).map((l) => l.seq)).toEqual([7, 8])
  })

  it('按字数切段，一句话不拆开', () => {
    const lines = dayTranscript(dayLog(), -1, T('09:00'))
    expect(chunkLines(lines, 10_000)).toHaveLength(1)
    expect(chunkLines(lines, 30).map((c) => c.map((l) => l.seq))).toEqual([[4], [5], [7], [8]])
  })

  it('给她的话：第一人称，对话按时间排，带上今天已经记下的和写的日记；说明什么都不记也可以', () => {
    const p = reviewPrompt({ ownerName: '老大', day: '2026-11-20', lines: dayTranscript(dayLog(), -1, T('09:00')), part: 1, parts: 1, kept: ['老大今天去面试了'], diary: ['【私人日记 21:00】\n老大面试过了'] })
    expect(p).toContain('09:10 老大：我今天面试，有点紧张')
    expect(p).toContain('09:10 我：别紧张，你准备得很充分了！')
    expect(p).toContain('· 老大今天去面试了')
    expect(p).toContain('【私人日记 21:00】')
    expect(p).toContain('什么都不记也完全可以')
    expect(p).not.toContain('Time sampled')
    expect(p).not.toContain('思考')
    expect(p).not.toContain('[QQ ·')
  })

  it('回顾哪一天：北京时间 06:00 前算前一天', () => {
    expect(reviewDay(new Date('2026-11-20T16:40:00Z'))).toMatchObject({ day: '2026-11-20' }) // 北京 11-21 00:40
    expect(reviewDay(new Date('2026-11-21T01:00:00Z')).day).toBe('2026-11-21') // 北京 09:00
    expect(reviewDay(new Date('2026-11-20T16:40:00Z')).since.toISOString()).toBe('2026-11-19T16:00:00.000Z')
  })

  it('时段：北京时间，支持跨零点', () => {
    const at = (hhmm: string) => new Date(`2026-11-20T${hhmm}:00+08:00`)
    const w = { start: '00:30', end: '05:45' }
    expect([inWindow(at('00:40'), w), inWindow(at('05:44'), w), inWindow(at('05:45'), w), inWindow(at('12:00'), w), inWindow(at('00:29'), w)]).toEqual([true, true, false, false, false])
    expect([inWindow(at('23:30'), { start: '23:00', end: '06:00' }), inWindow(at('03:00'), { start: '23:00', end: '06:00' }), inWindow(at('12:00'), { start: '23:00', end: '06:00' })]).toEqual([true, true, false])
  })

  it('花费估算：未命中 1 元 / 命中 0.02 元 / 输出 4 元（每百万 token）', () => {
    expect(estimateCost({ input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(5.02)
  })
})

describe('夜间回顾：惦记的事（2026-10-29）', () => {
  it('材料里列出还开着的惦记（带编号）；老大当天自己说了结果，她标“有结果了”，以后不再出现', async () => {
    const owner = { person: 'p_owner', channel: 'private' }
    const f = store.followUp({ what: '老大的面试怎么样了', askAfter: '2026-11-21' }, { viewer: owner, now: new Date(T('09:20')) })
    expect(f.ok).toBe(true)
    const id = (f as { id: string }).id
    const { model, seen } = fakeModel([{ name: 'follow_up', input: { action: '有结果了', id, outcome: '面试过了，下周一入职' } }])
    const r = await runNightReview({ ...base(), model })
    expect(r.status).toBe('done')
    expect(seen[0]!.prompt).toContain(`[${id}] 老大的面试怎么样了`)
    expect(seen[0]!.prompt).toContain('老大自己先说了结果也算')
    expect(store.openFollowUps(owner)).toHaveLength(0)
  })

  it('没有惦记的事时写“（没有）”，她也可以在回顾里惦记一件（标为夜间回顾写的）', async () => {
    const { model, seen } = fakeModel([{ name: 'follow_up', input: { action: '惦记', what: '老大入职第一天怎么样', ask_after: '2026-11-23' } }])
    await runNightReview({ ...base(), model })
    expect(seen[0]!.prompt).toContain('我惦记着的事：\n（没有）')
    const rows = store.db.prepare('SELECT written_in FROM follow_up').all() as Array<{ written_in: string }>
    expect(rows).toEqual([{ written_in: 'night-review' }])
  })
})

describe('夜间回顾：跑一次', () => {
  it('用她自己的系统提示；她用 keep_memory 记下的标为夜间回顾写的；游标推进到日志末尾；第二次没有新东西', async () => {
    const { model, seen } = fakeModel([{ name: 'keep_memory', input: { content: '老大面试过了，下周一入职。', importance: '很重要', about: '对方', kind: '事实' } }])
    const r = await runNightReview({ ...base(), model })
    expect(r).toMatchObject({ status: 'done', lines: 4, parts: 1, partsDone: 1, kept: 1, diary: 0, cursorFrom: -1, cursorTo: 8 })
    expect(seen[0]!.system).toBe('她的系统提示')
    expect(store.reviewCursor('sess-1')).toBe(8)
    const row = store.keptSince(new Date(T('09:00')))[0]!
    expect(row.content).toBe('老大面试过了，下周一入职。')
    const full = store.get(row.id)!
    expect(full.written_in).toBe('night-review')
    expect(JSON.parse(full.source_ref)).toMatchObject({ via: 'night_review', session: 'sess-1', from: 4, to: 8 })
    const again = await runNightReview({ ...base(), model })
    expect(again.status).toBe('nothing')
  })

  it('什么都不记是合法结果：系统不补记', async () => {
    const { model } = fakeModel([])
    const r = await runNightReview({ ...base(), model })
    expect(r).toMatchObject({ status: 'done', kept: 0, diary: 0 })
    expect(store.count()).toBe(0)
    expect(store.reviewCursor('sess-1')).toBe(8)
  })

  it('也可以写日记；写下的日记在她自己的目录里', async () => {
    const { model } = fakeModel([{ name: 'write_diary', input: { book: 'private', text: '老大面试过了，真替他高兴。' } }])
    const r = await runNightReview({ ...base(), model })
    expect(r.diary).toBe(1)
    expect(readdirSync(join(life, 'diary', books.dir('private')))).toHaveLength(1)
  })

  it('花费到了自限就停下：游标停在做完的那一段，第二晚接着做', async () => {
    const { model } = fakeModel([], { input_tokens: 600_000, output_tokens: 0 }) // 每步 ¥0.6
    const r = await runNightReview({ ...base(), model, maxChars: 30, budget: 0.5 })
    expect(r).toMatchObject({ status: 'incomplete', parts: 4, partsDone: 1, cursorTo: 4 })
    expect(r.reason).toContain('自限')
    expect(store.reviewCursor('sess-1')).toBe(4)
  })

  it('模型出错：不推进游标，报告原因（不含正文）', async () => {
    const model: ReviewModel = { async complete() { throw new Error('模型请求失败：HTTP 429 rate_limit') } }
    const r = await runNightReview({ ...base(), model })
    expect(r).toMatchObject({ status: 'incomplete', partsDone: 0, reason: '模型请求失败：HTTP 429 rate_limit' })
    expect(store.reviewCursor('sess-1')).toBeUndefined()
  })

  it('别人的私事写太细会被拒绝（和白天同一道守卫）', async () => {
    const { model } = fakeModel([{ name: 'keep_memory', input: { content: '老大的同事小王离婚了，前妻要走了房子和车', importance: '一般', about: '别人', kind: '事实' } }])
    const r = await runNightReview({ ...base(), model })
    expect(r.kept).toBe(0)
    expect(store.count()).toBe(0)
  })
})

describe('夜间回顾：第二阶段开关', () => {
  const p = { ownerName: '老大', day: '2026-11-20', lines: [{ seq: 1, time: T('20:00'), who: 'person' as const, text: '我妈做的酸豆角最好吃' }], part: 1, parts: 1, kept: [], diary: [] }
  it('默认（0.4.0）：有选择地记，什么都不记也可以', () => {
    const s = reviewPrompt(p)
    expect(s).toContain('什么都不记也完全可以')
    expect(s).not.toContain('一件事记一条')
    expect(s).not.toContain('日记里也不写细节')
  })
  it('I 记变化：开了才强调变化与听说的消息；关着和以前一样', () => {
    expect(reviewPrompt({ ...p, style: { detail: true } })).not.toContain('变了的事')
    const s = reviewPrompt({ ...p, style: { detail: true, changes: true } })
    expect(s).toContain('变了的事')
    expect(s).toContain('supersedes')
    expect(s).toContain('听说的消息')
  })
  it('A 记得全：具体事实一件一条；B 守隐私 / 遗忘：日记里也不写', () => {
    const s = reviewPrompt({ ...p, style: { detail: true, privacy: true } })
    expect(s).toContain('一件事记一条')
    expect(s).toContain('日记里也不写细节')
    expect(s).toContain('让我忘掉的事，不记、也不写进日记')
    expect(s).not.toContain('什么都不记也完全可以')
  })
})

describe('夜间回顾：多人（按人分开，设计 §3.8 第 5 条）', () => {
  it('和妹妹的对话：记进妹妹那一册，老大看不到；稳定层按人称呼；“今天已经记下的”不混进别人的', async () => {
    const owner = { person: 'p_owner', channel: 'private' }
    const sister = { person: 'p_sister', channel: 'private' }
    store.keep({ content: '老大最近在看心理医生。', importance: '很重要', about: '对方', kind: '事实' }, { viewer: owner, now: new Date(T('09:30')) })
    const { model, seen } = fakeModel([{ name: 'keep_memory', input: { content: '小雨在偷偷准备考研。', importance: '很重要', about: '对方', kind: '事实' } }])
    await runNightReview({ ...base(), model, person: { id: 'p_sister', name: '小雨' } })
    expect(seen[0]!.prompt).toContain('这是我今天和小雨的对话')
    expect(seen[0]!.prompt).not.toContain('心理医生')
    const rows = store.db.prepare('SELECT content, visibility, source_person FROM memory ORDER BY recorded_at').all() as Array<{ content: string; visibility: string; source_person: string }>
    expect(rows.find((r) => r.content.includes('考研'))).toMatchObject({ visibility: 'person:p_sister', source_person: 'p_sister' })
    expect(store.recall({ query: '考研' }, owner).found).toBe(false)
    expect(store.recall({ query: '考研' }, sister).found).toBe(true)
    const { stableLayer } = await import('@dsh-companion/memory')
    const s = stableLayer(store, sister, new Date(T('23:59')), { ownerName: '老大' })
    expect(s).toContain('## 关于小雨')
    expect(s).toContain('小雨亲口说的')
    expect(s).not.toContain('心理医生')
  })
})

// 开关 N：夜间封顶
describe('夜间回顾：开关 N（批量写、相关旧记忆、步数上限）', () => {
  const owner = { person: 'p_owner', channel: 'private' }

  it('一步记好几条（items）、标好几件（marks）；材料里带“可能和今天有关的旧记忆”（编号），且不算想起', async () => {
    const old = store.keep({ content: '老大在准备面试，投了好几家。', importance: '一般', about: '对方', kind: '事实' }, { viewer: owner, now: new Date(T('08:00') - 5 * 86400e3) })
    if (!old.ok) throw new Error(old.reason)
    const f = store.followUp({ what: '问问老大面试怎么样', askAfter: '2026-11-20' }, { viewer: owner, now: new Date(T('08:00') - 5 * 86400e3) })
    if (!f.ok) throw new Error(f.reason)
    const { model, seen } = fakeModel([
      { name: 'keep_memory', input: { items: [
        { content: '老大面试过了，下周一入职。', importance: '很重要', about: '对方', kind: '事实', supersedes: old.id },
        { content: '老大面试前有点紧张。', importance: '小事', about: '对方', kind: '事实' },
      ] } },
      { name: 'follow_up', input: { marks: [{ id: f.id, action: '有结果了', outcome: '过了' }] } },
    ])
    const rep = await runNightReview({ ...base(), model, lean: true })
    expect(rep.kept).toBe(2)
    expect(seen[0]!.prompt).toContain(`[${old.id}]`)
    expect(seen[0]!.prompt).toContain('一次写完')
    expect(store.get(old.id)!.superseded_at).not.toBeNull()
    expect(store.openFollowUps(owner)).toHaveLength(0)
    // 带进材料不算想起：不加强、不写 recall_log
    expect(store.get(old.id)!.recall_count).toBe(0)
    expect(store.db.prepare('SELECT count(*) AS n FROM recall_log').get()).toEqual({ n: 0 })
  })

  it('步数上限 6（不开 N 时 12）', async () => {
    let calls = 0
    const looping: ReviewModel = { async complete() { calls++; return { content: [{ type: 'tool_use', id: `t${calls}`, name: 'recall_memory', input: { query: '面试' } }], usage: { input_tokens: 10, output_tokens: 1 } } } }
    await runNightReview({ ...base(), model: looping, lean: true })
    expect(calls).toBe(6)
    calls = 0
    await runNightReview({ ...base(), sessionId: 'sess-x', model: looping })
    expect(calls).toBe(12)
  })
})

// 按语境隔离：调研“多人记忆隐私”查出的 5 条泄露路径逐条堵上
describe('夜间回顾：隐私按语境隔离', () => {
  const friend = { person: 'p_friend', channel: 'private' }
  const owner = { person: 'p_owner', channel: 'private' }

  it('路径 3 + 5：回顾阿杰那段写的日记进 private/@p_friend/，“给老大的日记”写不进去；之后回顾老大那段，材料里看不到', async () => {
    store.ensurePerson('p_friend', '阿杰')
    const { model } = fakeModel([
      { name: 'write_diary', input: { book: 'private', text: '阿杰说他被公司裁了，在家待着有点慌。' } },
      { name: 'write_diary', input: { book: 'to_laoda', text: '阿杰被裁员了。' } },
    ])
    await runNightReview({ ...base(), model, person: { id: 'p_friend', name: '阿杰' } })
    expect(readdirSync(join(life, 'diary', 'private', '@p_friend')).length).toBe(1)
    expect(readdirSync(join(life, 'diary', 'private')).filter((f) => f.endsWith('.md'))).toEqual([])
    expect(existsSync(join(life, 'diary', 'to-laoda')) ? readdirSync(join(life, 'diary', 'to-laoda')).filter((f) => f.endsWith('.md')) : []).toEqual([])
    // 同一天（11-20）两个语境各写一篇；回顾老大那段：“今天写的日记”里有老大语境那篇，没有阿杰的
    const { writeDiaryTool } = await import('../src/index.js')
    const at = () => new Date(T('22:00'))
    await writeDiaryTool(life, books, { ownerName: '老大', privateDiaryAudited: true, now: at, viewer: () => friend }).execute({ book: 'private', text: '阿杰说他被公司裁了。' })
    await writeDiaryTool(life, books, { ownerName: '老大', privateDiaryAudited: true, now: at }).execute({ book: 'private', text: '老大面试过了，真好。' })
    const seen2 = fakeModel([])
    await runNightReview({ ...base(), sessionId: 'sess-2', model: seen2.model })
    expect(seen2.seen[0]!.prompt).toContain('老大面试过了')
    expect(seen2.seen[0]!.prompt).not.toContain('裁')
  })

  it('路径 4：回顾老大那段时，“今天已经记下的”不列阿杰那段记下的条目', async () => {
    store.ensurePerson('p_friend', '阿杰')
    store.keep({ content: '阿杰欠了网贷，很愁。', importance: '一般', about: '对方', kind: '事实' }, { viewer: friend, now: new Date(T('10:00')) })
    store.keep({ content: '老大今天面试。', importance: '一般', about: '对方', kind: '事实' }, { viewer: owner, now: new Date(T('10:00')) })
    const { model, seen } = fakeModel([])
    await runNightReview({ ...base(), model })
    expect(seen[0]!.prompt).toContain('老大今天面试')
    expect(seen[0]!.prompt).not.toContain('网贷')
  })

  it('路径 1 + 2：老大语境翻日记 / 翻记忆翻不到阿杰语境写的；问到阿杰时附固定引导（有没有他的东西都一样）', async () => {
    const { recallDiaryTool, recallMemoryTool, writeDiaryTool } = await import('../src/index.js')
    store.ensurePerson('p_friend', '阿杰')
    const write = writeDiaryTool(life, books, { ownerName: '老大', privateDiaryAudited: true, viewer: () => friend })
    expect(((await write.execute({ book: 'private', text: '阿杰说他被公司裁了。' })) as { ok: boolean }).ok).toBe(true)
    const refused = (await write.execute({ book: 'to_laoda', text: '阿杰被裁了' })) as { ok: boolean; message: string }
    expect(refused.ok).toBe(false)
    expect(refused.message).toContain('私人日记')
    // 老大语境
    const rd = recallDiaryTool(life, books, { viewer: () => owner, people: () => store.people() })
    const r1 = (await rd.execute({ query: '阿杰 裁' })) as { found: boolean; message: string }
    expect(r1.found).toBe(false)
    expect(r1.message).toContain('阿杰单独跟我聊的事不会出现在这里')
    const rm = recallMemoryTool(store, () => owner, undefined, { lifeDir: life, books })
    const r2 = (await rm.execute({ query: '阿杰最近怎么样' })) as { message: string }
    expect(r2.message).not.toContain('裁')
    expect(r2.message).toContain('阿杰单独跟我聊的事不会出现在这里')
    // 阿杰自己的语境翻得到
    const rf = recallDiaryTool(life, books, { viewer: () => friend })
    expect(((await rf.execute({ query: '裁' })) as { found: boolean }).found).toBe(true)
    expect(((await rf.execute({ book: 'to_laoda' })) as { ok: boolean }).ok).toBe(false)
  })

  it('主人语境原样：日记位置、工具定义都不变', async () => {
    const { recallDiaryTool, writeDiaryTool } = await import('../src/index.js')
    const w = writeDiaryTool(life, books, { ownerName: '老大', privateDiaryAudited: true })
    await w.execute({ book: 'private', text: '今天很开心。' })
    expect(readdirSync(join(life, 'diary', 'private')).filter((f) => f.endsWith('.md')).length).toBe(1)
    expect(Object.keys((recallDiaryTool(life, books).parameters as { properties: object }).properties)).toEqual(['date', 'month', 'time', 'query', 'book'])
  })
})
