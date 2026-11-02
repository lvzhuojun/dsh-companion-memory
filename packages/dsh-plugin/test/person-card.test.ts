// 开关 T 插件侧：person_card 工具、夜间材料与注册（门控）、her-life 的 personCard 配置与日志
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { diaryBooks, MemoryStore, OWNER_ID, parseSessionLog, PERSON_CARD_MAX, type SessionLog, type Viewer } from '@dsh-companion/memory'
import { apply, runNightReview, type HostCtx, type ReviewBlock, type ReviewModel, type ToolDef } from '../src/index.js'
import { PERSON_CARD_LINE, personCardTool } from '../src/memory-tools.js'
import { cardSection, reviewPrompt } from '../src/night-review.js'

let life: string
let store: MemoryStore
const owner: Viewer = { person: OWNER_ID, channel: 'private' }
const T = (hhmm: string, d = '2026-11-20') => Date.parse(`${d}T${hhmm}:00+08:00`)
const fact = { importance: '一般', about: '对方', kind: '事实' } as const
const run = async (t: ToolDef, args: unknown) => (await t.execute(args)) as { ok: boolean; message: string; id?: string }
const props = (t: ToolDef) => (t.parameters as { properties: Record<string, { description?: string }> }).properties

beforeEach(() => {
  life = mkdtempSync(join(tmpdir(), 'card-plugin-'))
  store = MemoryStore.open(join(life, 'memory.db'), { ownerName: '老大' })
})
afterEach(() => {
  store.close()
  rmSync(life, { recursive: true, force: true })
})
const keepN = (n: number, day: string) => Array.from({ length: n }, (_, i) => {
  const r = store.keep({ ...fact, content: `老大说过的第 ${i + 1} 件事：喜欢第 ${i + 1} 种口味。` }, { viewer: owner, now: new Date(T(`10:${String(i).padStart(2, '0')}`, day)) })
  if (!r.ok) throw new Error(r.reason)
  return r.id
})

describe('person_card 工具', () => {
  it('一句说明、没有模板句；只有 text 一个参数', () => {
    const t = personCardTool(store, () => owner)
    expect(t.name).toBe('person_card')
    expect(t.description).toBe(PERSON_CARD_LINE)
    expect(t.description).toBe('用自己的话写一版对这个人的印象（400 字以内）：这个人是谁、现在的生活、和我的关系、我该记着的。只写我确定的。')
    expect(Object.keys(props(t))).toEqual(['text'])
  })

  it('写好返回第几版、based_on 记材料里的条目；超长拒绝并说明（不截断、不落库）', async () => {
    const t = personCardTool(store, () => owner, () => new Date(T('00:40')), () => ['m_x', 'm_y'])
    const bad = await run(t, { text: '字'.repeat(PERSON_CARD_MAX + 1) })
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain(`没写上：印象卡最多 ${PERSON_CARD_MAX} 字，这一版有 ${PERSON_CARD_MAX + 1} 字`)
    expect(store.personCard(owner)).toBeUndefined()
    const ok = await run(t, { text: '老大是把我养大的人。' })
    expect(ok).toMatchObject({ ok: true, message: '写好了（第 1 版）' })
    const c = store.personCard(owner)!
    expect(c.text).toBe('老大是把我养大的人。')
    expect(JSON.parse(c.based_on)).toEqual(['m_x', 'm_y'])
    expect((await run(t, { text: '第二版' })).message).toBe('写好了（第 2 版）')
  })
})

// ---------- 夜间 ----------

const qq = (seq: number, hhmm: string, text: string) => ({ type: 'user/message', seq, time: T(hhmm), data: { content: [{ type: 'text', text: `[QQ · 私聊] 老大：${text}` }], source: { kind: 'plugin:dsh-qq-bridge' }, role: 'user' } })
const me = (seq: number, hhmm: string, text: string) => ({ type: 'assistant/message', seq, time: T(hhmm), data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const sys = { type: 'system/message', seq: 1, time: T('08:00'), data: { message: { content: [{ type: 'text', text: '她的系统提示' }] } } }
const dayLog = (): SessionLog => parseSessionLog(Buffer.from([sys, qq(2, '12:00', '今天好累'), me(3, '12:00', '辛苦啦老大')].map((e) => JSON.stringify(e)).join('\n') + '\n'))

/** 假模型：第一步按 script 调工具，之后说“好了”；记下每段第一次看到的材料、工具名，以及工具结果 */
function fakeModel(script: Array<Array<{ name: string; input: unknown }>> = []) {
  const seen: Array<{ prompt: string; tools: string[] }> = []
  const results: string[] = []
  let step = 0
  const model: ReviewModel = {
    async complete({ messages, tools }) {
      if (messages.length === 1) seen.push({ prompt: messages[0]!.content as string, tools: tools.map((t) => t.name) })
      const last = messages[messages.length - 1]!
      if (Array.isArray(last.content)) for (const b of last.content) if (b.type === 'tool_result') results.push(b.content)
      const uses = script[step++]
      if (uses) return { content: uses.map((u, i) => ({ type: 'tool_use', id: `u${step}_${i}`, name: u.name, input: u.input })) as ReviewBlock[], usage: { input_tokens: 10, output_tokens: 1 } }
      return { content: [{ type: 'text', text: '好了' }] as ReviewBlock[], usage: { input_tokens: 10, output_tokens: 1 } }
    },
  }
  return { model, seen, results }
}

describe('夜间回顾：印象卡（开关 T）', () => {
  const books = diaryBooks({ ownerBook: 'to_laoda', ownerName: '老大' })
  const base = () => ({
    log: dayLog(), sessionId: 's', store, lifeDir: life, books, ownerName: '老大', privateDiaryAudited: true,
    since: new Date(T('00:00')), day: '2026-11-20', budget: 0.5, now: () => new Date(T('23:59') + 3600e3),
  })

  it('从没写过且 ≥ 10 条：材料里出现“该更新了（还没写过）”与新记下的；注册 person_card；写下的 based_on = 材料里列出的', async () => {
    const ids = keepN(12, '2026-11-19')
    const { model, seen, results } = fakeModel([[{ name: 'person_card', input: { text: '老大是把我养大的人。' } }, { name: 'person_card', input: { text: '再写一版' } }]])
    const r = await runNightReview({ ...base(), model, card: true })
    const p = seen[0]!.prompt
    expect(p).toContain('我对老大的印象卡该更新了（还没写过），用 person_card。\n这些天关于老大新记下的：\n· 老大说过的第 12 件事')
    expect(p).not.toContain('上一版')
    expect(seen[0]!.tools).toContain('person_card')
    expect(results[0]).toBe('写好了（第 1 版）')
    // 一晚最多一版
    expect(results[1]).toBe('没写上：今晚已经写过一版了（第 1 版）')
    expect(r.cardVersion).toBe(1)
    const c = store.personCard(owner)!
    expect(c.text).toBe('老大是把我养大的人。')
    expect(new Set(JSON.parse(c.based_on))).toEqual(new Set(ids))
  })

  it('有上一版：材料里带上一版日期与全文、只列上一版之后新记的', async () => {
    const old = keepN(3, '2026-10-01')
    store.writePersonCard(owner, '老大在成都做后端开发。我们有个梗。', old, new Date(T('00:40', '2026-10-02')))
    keepN(5, '2026-11-20')
    const { model, seen } = fakeModel()
    const r = await runNightReview({ ...base(), model, card: true })
    const p = seen[0]!.prompt
    expect(p).toContain('我对老大的印象卡该更新了（上一版 2026-10-02），用 person_card。\n上一版：\n老大在成都做后端开发。我们有个梗。\n这些天关于老大新记下的：\n')
    expect(p.split('这些天关于老大新记下的：\n')[1]!.split('\n\n')[0]!.match(/^· 老大说过的第/gm)).toHaveLength(5)
    expect(r.cardVersion).toBeUndefined()
  })

  it('门控不为真：材料、工具都和不开一样；不开时也一样', async () => {
    keepN(3, '2026-11-19')
    const off = fakeModel()
    await runNightReview({ ...base(), model: off.model })
    const on = fakeModel()
    await runNightReview({ ...base(), sessionId: 's2', model: on.model, card: true })
    expect(on.seen[0]!.prompt).toBe(off.seen[0]!.prompt)
    expect(on.seen[0]!.tools).toEqual(off.seen[0]!.tools)
    expect(on.seen[0]!.tools).not.toContain('person_card')
    expect(off.seen[0]!.prompt).not.toContain('印象卡')
  })

  it('不开：门控就算为真，也没有这一段和工具', async () => {
    keepN(12, '2026-11-19')
    const { model, seen } = fakeModel()
    await runNightReview({ ...base(), model })
    expect(seen[0]!.prompt).not.toContain('印象卡')
    expect(seen[0]!.tools).not.toContain('person_card')
  })

  it('reviewPrompt 不给 card 时逐字不变；cardSection 只陈述事实，没有模板句', () => {
    const p = { ownerName: '老大', day: '2026-11-20', lines: [], part: 1, parts: 1, kept: [], diary: [] }
    const withC = reviewPrompt({ ...p, card: '我对老大的印象卡该更新了（还没写过）' })
    expect(withC.replace('\n我对老大的印象卡该更新了（还没写过）\n', '')).toBe(reviewPrompt(p))
    const s = cardSection('老大', { due: true, why: ['stale'], newSince: 0, total: 3, recent: [] })
    expect(s).toBe('我对老大的印象卡该更新了（还没写过），用 person_card。\n这些天关于老大新记下的：\n（没有）')
    expect(s).not.toMatch(/例如|比如|可以这样写/)
  })
})

// ---------- her-life ----------

describe('her-life：personCard', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { for (const d of disposers.splice(0)) d() })
  function host() {
    const tools = new Map<string, ToolDef>()
    const variables = new Map<string, () => string>()
    const ctx: HostCtx = {
      effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
      systemPrompt: { variable: (name, p) => void variables.set(name, p) },
      tools: { register: (def) => void tools.set(def.name, def), schemas: () => [...tools.keys()].map((name) => ({ name })), restrict: () => {}, guard: () => {} },
    }
    return { ctx, tools, variables }
  }

  it('开：有卡时稳定层先放卡；白天不注册 person_card；日志报“人物卡（T）开”。关：稳定层没有卡，日志报“关”', () => {
    const dir = join(life, 'her')
    const seed = join(life, 'seed.md')
    writeFileSync(seed, '种子')
    mkdirSync(dir, { recursive: true })
    const s = MemoryStore.open(join(dir, 'memory.db'), { ownerName: '老大' })
    s.keep({ ...fact, content: '老大喜欢喝美式。' }, { viewer: owner, now: new Date(T('20:00', '2026-10-01')) })
    s.writePersonCard(owner, '老大是把我养大的人，在成都上班。', [], new Date(T('00:40', '2026-10-02')))
    s.close()
    const logs: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')))
    try {
      const h = host()
      apply(h.ctx, { ownerName: '老大', variablePrefix: 'her', seedPath: seed, lifeDir: dir, personCard: true })
      const mem = h.variables.get('her_memory')!()
      expect(mem).toContain('## 关于老大\n老大是把我养大的人，在成都上班。\n\n## 关于老大记下的\n· 老大喜欢喝美式。')
      expect(h.tools.has('person_card')).toBe(false)
      expect(logs.find((l) => l.includes('记忆 v2：'))).toMatch(/· 有效期（Y）关 · 人物卡（T）开$/)
      for (const d of disposers.splice(0)) d()
      logs.length = 0
      const h2 = host()
      apply(h2.ctx, { ownerName: '老大', variablePrefix: 'her', seedPath: seed, lifeDir: dir })
      const mem2 = h2.variables.get('her_memory')!()
      expect(mem2).not.toContain('把我养大')
      expect(mem2).toContain('## 关于老大\n· 老大喜欢喝美式。')
      expect(logs.find((l) => l.includes('记忆 v2：'))).toMatch(/· 人物卡（T）关$/)
    } finally {
      spy.mockRestore()
    }
  })
})
