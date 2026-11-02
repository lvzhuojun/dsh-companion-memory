// 开关 Y 插件侧：keep_memory 的 slot 参数与返回消息、夜间材料的级联段、her-life 的配置键
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { diaryBooks, MemoryStore, OWNER_ID, parseSessionLog, SLOT_KEYS, type SessionLog, type Viewer } from '@dsh-companion/memory'
import { apply, runNightReview, type HostCtx, type ReviewBlock, type ReviewModel, type ToolDef } from '../src/index.js'
import { keepMemoryTool, slotNote } from '../src/memory-tools.js'
import { cascadeSection, reviewPrompt } from '../src/night-review.js'

let life: string
let store: MemoryStore
const owner: Viewer = { person: OWNER_ID, channel: 'private' }
const T = (hhmm: string, d = '2026-11-20') => Date.parse(`${d}T${hhmm}:00+08:00`)
const fact = { importance: '一般', about: '对方', kind: '事实' } as const
const run = async (t: ToolDef, args: unknown) => (await t.execute(args)) as { ok: boolean; message: string; id?: string; ids?: string[] }
const props = (t: ToolDef) => (t.parameters as { properties: Record<string, { description?: string }> }).properties

beforeEach(() => {
  life = mkdtempSync(join(tmpdir(), 'slots-plugin-'))
  store = MemoryStore.open(join(life, 'memory.db'), { ownerName: '老大' })
})
afterEach(() => {
  store.close()
  rmSync(life, { recursive: true, force: true })
})

describe('keep_memory 的 slot（开关 Y）', () => {
  it('不开时工具定义和以前逐字一样（没有 slot 参数）；她传了 slot 也不生效', async () => {
    const off = keepMemoryTool(store, () => owner, '老大')
    expect(JSON.stringify(keepMemoryTool(store, () => owner, '老大', undefined, undefined, { slots: false }))).toBe(JSON.stringify(off))
    expect(props(off)).not.toHaveProperty('slot')
    const r = await run(off, { ...fact, content: '老大搬到苏州了。', slot: '住址' })
    expect(r.message).toBe(`记好了（编号 ${r.id}）`)
    expect(store.get(r.id!)!.slot).toBeNull()
  })

  it('开时多一个 slot 参数：描述列出全部封闭键，一行说明，没有台词', () => {
    const t = keepMemoryTool(store, () => owner, '老大', undefined, undefined, { slots: true })
    const d = props(t).slot!.description!
    for (const k of SLOT_KEYS) expect(d).toContain(k)
    expect(d).toContain('住哪、做什么、怎么上班、喜欢喝什么')
    expect(d).toContain('没有就不填')
    // 其余参数不变
    const off = props(keepMemoryTool(store, () => owner, '老大'))
    expect(Object.keys(props(t)).filter((k) => k !== 'slot')).toEqual(Object.keys(off))
  })

  it('系统自动标了键、让旧条失效了：如实告诉她；她自己标、没让什么失效：不多说', async () => {
    let now = new Date(T('20:00', '2026-08-05'))
    const t = keepMemoryTool(store, () => owner, '老大', () => now, undefined, { slots: true })
    const a = await run(t, { ...fact, content: '老大搬到苏州了。' })
    expect(a.message).toBe(`记好了（编号 ${a.id}）。已按【住址】记下。`)
    now = new Date(T('20:00', '2026-10-12'))
    const b = await run(t, { ...fact, content: '老大搬到成都了。' })
    expect(b.message).toBe(`记好了（编号 ${b.id}）。已按【住址】记下，之前那条 [${a.id}] 不再算现在的了，翻得到。`)
    const c = await run(t, { ...fact, content: '老大感冒了。', slot: '健康' })
    expect(c.message).toBe(`记好了（编号 ${c.id}）`)
    const d = await run(t, { ...fact, content: '老大现在坐地铁上班', slot: '上班的路' })
    expect(d.message).toBe(`记好了（编号 ${d.id}）。【上班的路】不在常用的键里，按“其它:上班的路”记了；像的有：通勤。`)
    const e = await run(t, { ...fact, content: '老大最喜欢周杰伦', slot: '其它:老大最喜欢的歌手' })
    expect(e.ok).toBe(false)
    expect(e.message).toContain('没记上：slot')
  })

  it('批量（开关 N）每条各自报', async () => {
    let now = new Date(T('20:00', '2026-08-05'))
    const t = keepMemoryTool(store, () => owner, '老大', () => now, undefined, { batch: true, slots: true })
    expect(props(t)).toHaveProperty('slot')
    const a = await run(t, { items: [{ ...fact, content: '老大搬到苏州了。' }, { ...fact, content: '老大喜欢吃辣。' }] })
    expect(a.message).toMatch(/^1\. 记好了（编号 m_\w+）。已按【住址】记下。\n2\. 记好了（编号 m_\w+）$/)
    now = new Date(T('20:00', '2026-10-12'))
    const b = await run(t, { items: [{ ...fact, content: '老大搬到成都了。', slot: '住址' }] })
    expect(b.message).toContain(`之前那条 [${a.ids![0]}] 不再算现在的了，翻得到。`)
  })

  it('slotNote：几条一起失效时列编号', () => {
    expect(slotNote(undefined)).toBe('')
    expect(slotNote({ key: '通勤', by: 'her', invalidated: ['m_a', 'm_b'] })).toBe('。已按【通勤】记下，之前那 2 条 [m_a]、[m_b] 不再算现在的了，翻得到。')
  })
})

// ---------- 夜间：级联段 ----------

const qq = (seq: number, hhmm: string, text: string) => ({ type: 'user/message', seq, time: T(hhmm), data: { content: [{ type: 'text', text: `[QQ · 私聊] 老大：${text}` }], source: { kind: 'plugin:dsh-qq-bridge' }, role: 'user' } })
const me = (seq: number, hhmm: string, text: string) => ({ type: 'assistant/message', seq, time: T(hhmm), data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } })
const sys = { type: 'system/message', seq: 1, time: T('08:00'), data: { message: { content: [{ type: 'text', text: '她的系统提示' }] } } }
const dayLog = (): SessionLog => parseSessionLog(Buffer.from([sys, qq(2, '12:00', '我搬到成都了！'), me(3, '12:00', '恭喜老大！')].map((e) => JSON.stringify(e)).join('\n') + '\n'))

function fakeModel() {
  const seen: Array<{ prompt: string; tools: string[]; keepProps: string[] }> = []
  const model: ReviewModel = {
    async complete({ messages, tools }) {
      if (messages.length === 1) {
        const keep = tools.find((t) => t.name === 'keep_memory')!
        seen.push({ prompt: messages[0]!.content as string, tools: tools.map((t) => t.name), keepProps: Object.keys((keep.input_schema as { properties: object }).properties) })
      }
      return { content: [{ type: 'text', text: '好了' }] as ReviewBlock[], usage: { input_tokens: 10, output_tokens: 1 } }
    },
  }
  return { model, seen }
}

describe('夜间回顾：今天变了的事与级联候选（开关 Y）', () => {
  const books = diaryBooks({ ownerBook: 'to_laoda', ownerName: '老大' })
  const base = () => ({
    log: dayLog(), sessionId: 's', store, lifeDir: life, books, ownerName: '老大', privateDiaryAudited: true,
    since: new Date(T('00:00')), day: '2026-11-20', budget: 0.5, now: () => new Date(T('23:59') + 3600e3),
  })
  const seedDay = () => {
    const ctx = (d: number) => ({ viewer: owner, now: new Date(d), slots: true })
    const home = store.keep({ ...fact, content: '老大搬到苏州了。' }, ctx(T('20:00', '2026-11-01')))
    const car = store.keep({ ...fact, content: '老大开车上班，单程四十分钟。' }, ctx(T('20:00', '2026-11-02')))
    const moved = store.keep({ ...fact, content: '老大搬到成都了。' }, ctx(T('12:01')))
    if (!home.ok || !car.ok || !moved.ok) throw new Error('keep')
    return { home: home.id, car: car.id, moved: moved.id }
  }

  it('材料里出现“今天这些事变了（旧 → 新）”与候选（编号 + 键）；只陈述事实；keep_memory 夜里也有 slot', async () => {
    const ids = seedDay()
    const { model, seen } = fakeModel()
    await runNightReview({ ...base(), model, slots: true })
    const p = seen[0]!.prompt
    expect(p).toContain('今天这些事变了（旧 → 新）：\n· 【住址】老大搬到苏州了。 → 老大搬到成都了。\n心里记着的这些可能也跟着变了：\n')
    expect(p).toContain(`· [${ids.car}] 老大开车上班，单程四十分钟。（通勤）`)
    expect(p).not.toContain(`[${ids.home}]`)
    expect(seen[0]!.keepProps).toContain('slot')
  })

  it('不开时：材料、工具都和以前一样', async () => {
    seedDay()
    const { model, seen } = fakeModel()
    await runNightReview({ ...base(), model })
    expect(seen[0]!.prompt).not.toContain('今天这些事变了')
    expect(seen[0]!.keepProps).not.toContain('slot')
  })

  it('没有候选就不出这一节；reviewPrompt 不给 cascade 时逐字不变', () => {
    expect(cascadeSection([{ slot: '住址', old: { id: 'm_a', text: '旧' }, candidates: [] }])).toBeUndefined()
    const p = { ownerName: '老大', day: '2026-11-20', lines: [], part: 1, parts: 1, kept: [], diary: [] }
    expect(reviewPrompt({ ...p })).toBe(reviewPrompt(p))
    const withC = reviewPrompt({ ...p, cascade: '今天这些事变了（旧 → 新）：\n· x' })
    expect(withC.replace('\n今天这些事变了（旧 → 新）：\n· x\n', '')).toBe(reviewPrompt(p))
    // 只陈述事实：没有命令句
    const s = cascadeSection([{ slot: '住址', old: { id: 'm_a', text: '老大搬到苏州了。' }, now: { id: 'm_b', text: '老大搬到成都了。' }, candidates: [{ id: 'm_c', text: '老大开车上班', slot: '通勤' }] }])!
    expect(s).not.toMatch(/用 keep_memory|记一条|标一下|看看/)
  })
})

// ---------- her-life：配置键 ----------

describe('her-life：memorySlots', () => {
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

  it('开：keep_memory 有 slot；稳定层只列有效的；日志行报“有效期（Y）开”。关：没有 slot，日志报“关”', () => {
    const dir = join(life, 'her')
    const seed = join(life, 'seed.md')
    writeFileSync(seed, '种子')
    const logs: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')))
    try {
      const h = host()
      apply(h.ctx, { ownerName: '老大', variablePrefix: 'her', seedPath: seed, lifeDir: dir, memorySlots: true })
      expect(props(h.tools.get('keep_memory')!)).toHaveProperty('slot')
      expect(logs.find((l) => l.includes('记忆 v2：'))).toContain('· 有效期（Y）开')
      for (const d of disposers.splice(0)) d()
      // 失效的旧条不在稳定层
      const s = MemoryStore.open(join(dir, 'memory.db'), { ownerName: '老大' })
      s.keep({ ...fact, content: '老大搬到苏州了。', importance: '很重要' }, { viewer: owner, now: new Date(T('20:00', '2026-08-05')), slots: true })
      s.keep({ ...fact, content: '老大搬到成都了。' }, { viewer: owner, now: new Date(T('20:00', '2026-10-12')), slots: true })
      s.close()
      const h2 = host()
      apply(h2.ctx, { ownerName: '老大', variablePrefix: 'her', seedPath: seed, lifeDir: dir, memorySlots: true })
      const mem = h2.variables.get('her_memory')!()
      expect(mem).toContain('成都')
      expect(mem).not.toContain('苏州')
      for (const d of disposers.splice(0)) d()
      logs.length = 0
      const h3 = host()
      apply(h3.ctx, { ownerName: '老大', variablePrefix: 'her', seedPath: seed, lifeDir: dir })
      expect(props(h3.tools.get('keep_memory')!)).not.toHaveProperty('slot')
      expect(logs.find((l) => l.includes('记忆 v2：'))).toContain('· 有效期（Y）关')
    } finally {
      spy.mockRestore()
    }
  })
})
