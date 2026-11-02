// 记忆 v2 读侧接 DSH：pre-step 追加“想起来的”、压缩代次换代、默认不变
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, NOTICE_HEAD, OWNER_ID } from '@dsh-companion/memory'
import { apply, memoryRules, type HerLifeConfig, type HostCtx, type ToolDef } from '../src/index.js'
import { BIG_PREFIX_CHARS, cacheKey } from '../src/her-life.js'
import { FOLLOW_UP_STRICT_LINE } from '../src/memory-tools.js'
import { compactionCounter, loadCreateUserMessage, makeNoticer, personText, preStepHandler, type PreStepDecision } from '../src/read-side.js'

const owner = { person: OWNER_ID, channel: 'private' }
const at = (s: string) => new Date(`${s}+08:00`)
let dir: string
const disposers: Array<() => void> = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'read-side-')) })
afterEach(() => {
  for (const d of disposers.splice(0)) d()
  rmSync(dir, { recursive: true, force: true })
})

const qq = (text: string) => ({ content: [{ type: 'text', text: `[QQ · 私聊] 老大：${text}` }], source: { kind: 'plugin:dsh-qq-bridge' } })
const fakeCreate = (input: { content: unknown; source: unknown }) => ({ role: 'user', ...input })

describe('真人消息', () => {
  it('只认网页 / QQ 桥来源；去掉 QQ 包装；注入、时间、快照、压缩检查点都不算', () => {
    expect(personText([qq('我对什么过敏来着')])).toBe('我对什么过敏来着')
    expect(personText([{ content: [{ type: 'text', text: '网页上打的字' }], source: { kind: 'user' } }])).toBe('网页上打的字')
    for (const kind of ['time-context', 'runtime-context', 'compact-checkpoint', 'her-life', 'tool-jobs']) {
      expect(personText([{ content: [{ type: 'text', text: 'x' }], source: { kind } }])).toBeUndefined()
    }
    expect(personText([])).toBeUndefined()
    expect(personText(undefined)).toBeUndefined()
  })
})

describe('pre-step：有真人消息、有内容才追加一条', () => {
  const setup = () => {
    const store = MemoryStore.open(join(dir, 'm.db'), { ownerName: '老大' })
    disposers.push(() => store.close())
    for (let i = 0; i < 10; i++) store.keep({ content: `老大说今天第${i}次加班了。`, importance: '一般', about: '对方', kind: '事实' }, { viewer: owner, now: at(`2026-10-${10 + i}T20:00:00`) })
    store.keep({ content: '老大对芒果过敏，吃了会起疹子。', importance: '一般', about: '对方', kind: '事实' }, { viewer: owner, now: at('2026-10-01T20:00:00') })
    const noticer = makeNoticer({ store, viewer: () => owner, inject: true, followTrigger: true, prefixIds: () => [], names: () => ['老大'], now: () => at('2026-10-30T09:00:00'), gate: { cue: 1.0, soft: 2.0, hi: 3.0, delta: 0.8 } })
    return { store, noticer }
  }

  it('问到记着的事 → 在本步消息后面追加 her-life / recall；同一条 12 轮内不再注入', async () => {
    const { noticer } = setup()
    const h = preStepHandler(noticer, () => fakeCreate)
    const d = await h({}, async () => ({ kind: 'enter', messages: [qq('我对什么过敏来着？')] }))
    expect(d.messages).toHaveLength(2)
    const added = d.messages![1] as { content: Array<{ text: string }>; source: { kind: string; form: string } }
    expect(added.source).toEqual({ kind: 'her-life', form: 'recall' })
    expect(added.content[0]!.text.startsWith(NOTICE_HEAD)).toBe(true)
    expect(added.content[0]!.text).toContain('芒果')
    const again = await h({}, async () => ({ kind: 'enter', messages: [qq('我对什么过敏来着？')] }))
    expect(again.messages).toHaveLength(1)
  })

  it('工具循环的中间步（没有真人消息）、闲聊、拒绝的决策、create 还没就绪：原样放行', async () => {
    const { noticer } = setup()
    const h = preStepHandler(noticer, () => fakeCreate)
    const toolStep: PreStepDecision = { kind: 'enter', messages: [] }
    expect(await h({}, async () => toolStep)).toBe(toolStep)
    const chat: PreStepDecision = { kind: 'enter', messages: [qq('今天好热啊')] }
    expect(await h({}, async () => chat)).toBe(chat)
    const reject: PreStepDecision = { kind: 'reject' }
    expect(await h({}, async () => reject)).toBe(reject)
    const notReady = preStepHandler(noticer, () => null)
    const d: PreStepDecision = { kind: 'enter', messages: [qq('我芒果过敏吗')] }
    expect(await notReady({}, async () => d)).toBe(d)
  })

  it('出错时只记日志、返回原决策（她这一轮照常说话）', async () => {
    const logs: unknown[] = []
    const h = preStepHandler(() => { throw new Error('库坏了') }, () => fakeCreate, (...a) => logs.push(a))
    const d: PreStepDecision = { kind: 'enter', messages: [qq('我芒果过敏吗')] }
    expect(await h({}, async () => d)).toBe(d)
    expect(String(logs[0])).toContain('库坏了')
  })

  it('到日子的惦记 → 追加“该问问了”', async () => {
    const { store, noticer } = setup()
    store.followUp({ what: '老大周三面试，问问结果', askAfter: '2026-10-29' }, { viewer: owner, now: at('2026-10-20T20:00:00') })
    const d = await preStepHandler(noticer, () => fakeCreate)({}, async () => ({ kind: 'enter', messages: [qq('在吗')] }))
    expect((d.messages![1] as { content: Array<{ text: string }> }).content[0]!.text).toContain('【该问问了】老大周三面试')
  })
})

describe('压缩代次与换代键', () => {
  it('只数没出错的 compaction/end', () => {
    let n = 0
    const f = compactionCounter(() => n++)
    f({}, { type: 'compaction/start' })
    f({}, { type: 'compaction/end', data: { error: 'x' } })
    f({}, { type: 'compaction/end', data: {} })
    expect(n).toBe(1)
  })

  it('小前缀：代次或日子变就换；大前缀：3 天一桶', () => {
    expect(cacheKey(0, '2026-10-30', 100)).toBe('0:2026-10-30')
    expect(cacheKey(1, '2026-10-30', 100)).not.toBe(cacheKey(0, '2026-10-30', 100))
    const big = BIG_PREFIX_CHARS + 1
    const keys = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map((d) => cacheKey(0, d, big))
    expect(new Set(keys).size).toBeLessThanOrEqual(3)
    expect(new Set(keys).size).toBeGreaterThanOrEqual(2)
  })

  it('DSH 外面加载不到 createUserMessage 时返回 null（不抛错）', async () => {
    expect(await loadCreateUserMessage({ importer: async () => { throw new Error('no') }, anchors: [] })).toBeNull()
    const f = () => 1
    expect(await loadCreateUserMessage({ importer: async () => ({ createUserMessage: f }), anchors: [] })).toBe(f)
  })
})

describe('插件挂载', () => {
  function host() {
    const variables = new Map<string, () => string>()
    const tools = new Map<string, ToolDef>()
    const on = new Map<string, (...a: never[]) => unknown>()
    const ctx: HostCtx = {
      effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
      systemPrompt: { variable: (name, p) => void variables.set(name, p) },
      tools: { register: (def) => void tools.set(def.name, def), schemas: () => [...tools.keys()].map((name) => ({ name })), restrict: () => {}, guard: () => {} },
      on: (name, h) => void on.set(name, h),
    }
    return { ctx, variables, tools, on }
  }
  const XJ = (life: string, seed: string): HerLifeConfig => ({ ownerName: '老大', ownerBook: 'to_laoda', variablePrefix: 'her', privateDiaryAudited: true, seedPath: seed, lifeDir: life, askFirst: true, timeCalc: true })

  it('默认（J、K、P 都不给）：规则、follow_up 工具和 0.5.1 一样；只挂压缩计数，不挂 pre-step', () => {
    const seed = join(dir, 'seed.md'); writeFileSync(seed, 's')
    const h = host()
    apply(h.ctx, XJ(dir, seed))
    expect(h.variables.get('her_memory')!()).toBe(memoryRules({ ownerName: '老大', privateDiaryAudited: true, memory: true, askFirst: true, timeCalc: true }))
    expect(Object.keys((h.tools.get('follow_up')!.parameters as { properties: object }).properties)).not.toContain('keys')
    expect([...h.on.keys()]).toEqual(['session/event'])
  })

  it('开 J、K：挂 pre-step；规则多两行；follow_up 多 keys；压缩后稳定层换代', () => {
    const seed = join(dir, 'seed.md'); writeFileSync(seed, 's')
    const h = host()
    apply(h.ctx, { ...XJ(dir, seed), inject: true, followTrigger: true, prefixTier: 'P100' })
    expect([...h.on.keys()].sort()).toEqual(['agent/pre-step', 'session/event'])
    const mem = h.variables.get('her_memory')!
    expect(mem()).toContain('【我想起来的】')
    expect(mem()).toContain('【该问问了】')
    expect(Object.keys((h.tools.get('follow_up')!.parameters as { properties: object }).properties)).toContain('keys')
    // 记一条 → 当代不变；压缩一次 → 换代后出现
    const before = mem()
    void h.tools.get('keep_memory')!.execute({ content: '老大喜欢陈奕迅。', importance: '一般', about: '对方', kind: '事实' })
    expect(mem()).toBe(before)
    ;(h.on.get('session/event') as (s: unknown, e: unknown) => void)({}, { type: 'compaction/end', data: {} })
    expect(mem()).toContain('老大喜欢陈奕迅。')
    // 代次记在库里，重启后接着数
    const db = MemoryStore.open(join(dir, 'memory.db'), { ownerName: '老大' })
    expect(db.getKv('compaction_gen')).toBe('1')
    db.close()
  })

  it('开关 F：follow_up 去掉 0.5.1 那句收紧的话；不开时照旧', () => {
    const seed = join(dir, 'seed.md'); writeFileSync(seed, 's')
    const a = host(); apply(a.ctx, XJ(dir, seed))
    expect(a.tools.get('follow_up')!.description).toContain(FOLLOW_UP_STRICT_LINE)
    for (const d of disposers.splice(0)) d()
    const b = host(); apply(b.ctx, { ...XJ(dir, seed), followUpLoose: true })
    expect(b.tools.get('follow_up')!.description).not.toContain('随口说的愿望')
    expect(b.tools.get('follow_up')!.description).toContain('惦记一件过几天想问问的事')
  })

  it('prefix 写错直接报错', () => {
    const seed = join(dir, 'seed.md'); writeFileSync(seed, 's')
    expect(() => apply(host().ctx, { ...XJ(dir, seed), prefixTier: 'P999' as never })).toThrow(/prefixTier/)
  })
})
