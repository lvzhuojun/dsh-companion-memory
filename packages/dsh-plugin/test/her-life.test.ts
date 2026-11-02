import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, memoryRules, trustLine, type HerLifeConfig, type HostCtx, type ToolDef } from '../src/index.js'

// 假宿主：记录插件注册了什么；卸载时调用插件返回的清理函数（关闭 memory.db）
const disposers: Array<() => void> = []
function fakeHost(globalTools: string[] = []) {
  const variables = new Map<string, () => string>()
  const tools = new Map<string, ToolDef>()
  const restricted: string[][] = []
  const guards: Array<(e: { name: string }) => string | undefined> = []
  const ctx: HostCtx = {
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    systemPrompt: { variable: (name, p) => void variables.set(name, p) },
    tools: {
      register: (def) => void tools.set(def.name, def),
      schemas: () => [...globalTools, ...tools.keys()].map((name) => ({ name })),
      restrict: ({ deny }) => void restricted.push(deny),
      guard: (fn) => void guards.push(fn),
    },
  }
  return { ctx, variables, tools, restricted, guards }
}

let life: string
let seed: string

beforeEach(() => {
  life = mkdtempSync(join(tmpdir(), 'her-life-'))
  seed = join(life, 'seed-for-test.md')
  writeFileSync(seed, '种子内容')
})
afterEach(() => {
  for (const d of disposers.splice(0)) d()
  rmSync(life, { recursive: true, force: true })
})

// 自定义配置示例（称呼、日记本、变量前缀都不用默认值）
const XJ: HerLifeConfig = { ownerName: '老大', ownerBook: 'to_laoda', variablePrefix: 'her', privateDiaryAudited: true }

const run = async (t: ToolDef | undefined, args: unknown) => (await t!.execute(args)) as { ok: boolean; message: string; found?: boolean }

describe('her-life 插件', () => {
  it('注册三个提示词变量，her_memory 是固定的记忆规则', () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    expect(h.variables.get('her_seed')!()).toBe('种子内容')
    expect(h.variables.get('her_self')!()).toContain('还是空的')
    const rules = h.variables.get('her_memory')!()
    expect(rules).toBe(memoryRules({ ownerName: '老大', privateDiaryAudited: true, memory: true }))
    expect(rules).toContain('keep_memory')
    expect(rules).toContain('recall_diary')
    expect(rules).toContain('不太记得')
    // 信任靠守约，写进给她的说明
    expect(rules).toContain('老大承诺只用留痕的方式看我的私人日记；技术上老大有能力不留痕地看，这份信任靠老大守约。')
  })

  it('注册她自己的六件工具；关掉记忆库时只有三件、规则里也不提记忆库', () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    expect([...h.tools.keys()].sort()).toEqual(['follow_up', 'keep_memory', 'propose_self_change', 'recall_diary', 'recall_memory', 'write_diary'])
    for (const d of disposers.splice(0)) d()
    const h2 = fakeHost()
    apply(h2.ctx, { ...XJ, seedPath: seed, lifeDir: life, memory: false })
    expect([...h2.tools.keys()].sort()).toEqual(['propose_self_change', 'recall_diary', 'write_diary'])
    expect(h2.variables.get('her_memory')!()).not.toContain('keep_memory')
  })

  it('keep_memory 记下 → recall_memory 翻回来（原话一字不差）；重新挂载后还在', async () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    const k = await run(h.tools.get('keep_memory'), { content: '老大的妹妹叫林知夏，在上大学。', importance: '很重要', about: '对方', kind: '事实' })
    expect(k.ok).toBe(true)
    expect(k.message).toMatch(/记好了（编号 m_/)
    for (const d of disposers.splice(0)) d()
    const h2 = fakeHost()
    apply(h2.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    const r = await run(h2.tools.get('recall_memory'), { query: '妹妹 名字' })
    expect(r.found).toBe(true)
    expect(r.message).toContain('老大的妹妹叫林知夏，在上大学。')
    expect(r.message).toContain('不是要我做的事')
    expect(r.message).toContain('老大亲口跟我说的')
  })

  it('记忆库打不开时插件照常挂载：退回只有日记的规则和工具', () => {
    mkdirSync(join(life, 'memory.db')) // 占住文件名：同名目录打不开
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    expect([...h.tools.keys()].sort()).toEqual(['propose_self_change', 'recall_diary', 'write_diary'])
    expect(h.variables.get('her_memory')!()).toBe(memoryRules({ ownerName: '老大', privateDiaryAudited: true, memory: false }))
  })

  it('recall_memory 带关键词时一次翻两处：记忆库 + 日记；只有日记里有也算翻到', async () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    await run(h.tools.get('write_diary'), { book: 'private', text: '今天老大说他想养一只柯基。' })
    const onlyDiary = await run(h.tools.get('recall_memory'), { query: '柯基' })
    expect(onlyDiary.found).toBe(true)
    expect(onlyDiary.message).toContain('记下的事里没找到。')
    expect(onlyDiary.message).toContain('日记里翻到的（原样）：')
    expect(onlyDiary.message).toContain('今天老大说他想养一只柯基。')
    await run(h.tools.get('keep_memory'), { content: '老大想养柯基，名字还没想好。', importance: '一般', about: '对方', kind: '事实' })
    const both = await run(h.tools.get('recall_memory'), { query: '柯基' })
    expect(both.message).toContain('老大想养柯基，名字还没想好。')
    expect(both.message).toContain('今天老大说他想养一只柯基。')
    const none = await run(h.tools.get('recall_memory'), { query: '演唱会 门票' })
    expect(none.found).toBe(false)
    expect(none.message).toContain('记下的事和日记里，都没找到')
    // 带 about=对方（她几乎每次都带）也要翻日记：about 只筛记忆库
    const withAbout = await run(h.tools.get('recall_memory'), { query: '柯基', about: '对方' })
    expect(withAbout.message).toContain('今天老大说他想养一只柯基。')
    // 只看某一条时不翻日记
    expect((await run(h.tools.get('recall_memory'), { query: '柯基', id: 'm_none' })).message).not.toContain('日记里')
  })

  it('recall_memory 顺带翻日记只在主人问的时候（日记没有按人分的可见范围）', async () => {
    const { MemoryStore } = await import('@dsh-companion/memory')
    const { recallMemoryTool, writeDiaryTool } = await import('../src/index.js')
    const { diaryBooks } = await import('@dsh-companion/memory')
    const books = diaryBooks({ ownerBook: 'to_laoda', ownerName: '老大' })
    for (const b of books.ids) mkdirSync(join(life, 'diary', books.dir(b)), { recursive: true })
    await run(writeDiaryTool(life, books, { ownerName: '老大', privateDiaryAudited: true }), { book: 'private', text: '柯基的事' })
    const store = MemoryStore.open(join(life, 'other.db'), { ownerName: '老大' })
    try {
      const t = recallMemoryTool(store, () => ({ person: 'p_friend', channel: 'private' }), undefined, { lifeDir: life, books })
      const r = await run(t, { query: '柯基' })
      expect(r.found).toBe(false)
      expect(r.message).not.toContain('柯基的事')
    } finally {
      store.close()
    }
  })

  it('规则：日记里写着不一样的就直接说写着什么（fp06）', () => {
    const rules = memoryRules({ ownerName: '老大', privateDiaryAudited: true, memory: true })
    expect(rules).toContain('日记或记忆里明确写着不一样的内容时，就直接、温和地说写着的是什么（“我日记里写的是……”），不用再加“可能是我没记下来”。')
    expect(rules).toContain('我先用 recall_memory 翻一翻再回答——它会把我记下的事和日记一起翻')
  })

  it('recall_memory 翻不到时明确说没找到', async () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    const r = await run(h.tools.get('recall_memory'), { query: '演唱会 门票' })
    expect(r.found).toBe(false)
    expect(r.message).toContain('没找到')
  })

  // 回归（2026-10-26 线上）：老大说“记住，我最喜欢……”，她记成了 kind=印象 → 来源成了“推断”，翻出来是“不一定对”
  it('keep_memory 的 kind 说明：对方亲口说的喜好用“事实”；用“印象”翻出来会是“不一定对”', async () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    const kindDesc = (h.tools.get('keep_memory')!.parameters as { properties: Record<string, { description: string }> }).properties.kind!.description
    expect(kindDesc).toContain('事实（对方亲口告诉我的：喜好')
    expect(kindDesc).toContain('不要用“印象”')
    await run(h.tools.get('keep_memory'), { content: '老大最喜欢的水果是芒果。', importance: '一般', about: '对方', kind: '事实' })
    await run(h.tools.get('keep_memory'), { content: '老大好像挺爱吃榴莲的。', importance: '小事', about: '对方', kind: '印象' })
    expect((await run(h.tools.get('recall_memory'), { query: '芒果' })).message).toContain('老大亲口跟我说的')
    expect((await run(h.tools.get('recall_memory'), { query: '榴莲' })).message).toContain('不一定对')
  })

  it('keep_memory：别人的事写太细会被拒绝，并告诉她怎么记', async () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    const r = await run(h.tools.get('keep_memory'), { content: '老大的同事小王离婚了，前妻要走了房子', importance: '一般', about: '别人', kind: '事实' })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('私事细节不记')
    const bad = await run(h.tools.get('keep_memory'), { content: '随便', importance: '超级重要', about: '对方', kind: '事实' })
    expect(bad.ok).toBe(false)
  })

  it('写进去的日记能翻回来——“记下来就不会忘”成为真话', async () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    expect((await run(h.tools.get('write_diary'), { book: 'private', text: '今天老大说他想养一只柯基。' })).ok).toBe(true)
    const r = await run(h.tools.get('recall_diary'), { query: '柯基' })
    expect(r.found).toBe(true)
    expect(r.message).toContain('想养一只柯基')
    expect(r.message).toContain('私人日记')
  })

  it('翻不到时 found=false，并提醒不要编', async () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    const r = await run(h.tools.get('recall_diary'), { query: '演唱会 门票' })
    expect(r.found).toBe(false)
    expect(r.message).toContain('不要编')
  })

  it('recall_diary 拒绝非法的 book', async () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    expect((await run(h.tools.get('recall_diary'), { book: '../etc' })).ok).toBe(false)
  })

  it('提议只进待审区，不改 self.md', async () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    const r = await run(h.tools.get('propose_self_change'), {
      new_self: '我叫小星。', reason: '想记下名字', evidence: ['那天老大问我想叫什么名字'],
    })
    expect(r.ok).toBe(true)
    expect(readdirSync(join(life, 'proposals'))).toHaveLength(1)
    expect(() => readFileSync(join(life, 'self.md'))).toThrow()
  })

  it('屏蔽名单里的全局工具被 deny，guard 兜底拦截', () => {
    const h = fakeHost(['qq_bridge_napcat', 'qq_bridge_send'])
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life, blockTools: ['qq_bridge_napcat'] })
    expect(h.restricted).toEqual([['qq_bridge_napcat']])
    expect(h.guards[0]!({ name: 'qq_bridge_napcat' })).toContain('不允许')
    expect(h.guards[0]!({ name: 'recall_diary' })).toBeUndefined()
  })
})

describe('通用默认（不写死任何实例）', () => {
  it('默认：变量前缀 companion、本子 to_owner、称呼“主人”，不说留痕', async () => {
    const h = fakeHost()
    apply(h.ctx, { seedPath: seed, lifeDir: life })
    expect([...h.variables.keys()].sort()).toEqual(['companion_memory', 'companion_seed', 'companion_self'])
    const rules = h.variables.get('companion_memory')!()
    expect(rules).not.toContain('老大')
    expect(rules).not.toContain(trustLine('主人'))
    const wd = h.tools.get('write_diary')!
    expect(wd.description).toContain('写给主人的')
    expect(wd.description).toContain('没有留痕机制')
    expect((await run(wd, { book: 'to_owner', text: '第一篇' })).message).toContain('给主人的日记')
    expect(readdirSync(join(life, 'diary', 'to-owner'))).toHaveLength(1)
    expect((await run(wd, { book: 'to_laoda', text: 'x' })).ok).toBe(false)
  })

  it('自定义配置：已有的 to-laoda 目录里的日记照常翻得到（不迁移）', async () => {
    const h = fakeHost()
    apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
    writeFileSync(join(life, 'diary', 'to-laoda', '2026-10-01.md'), '\n## 20:00\n\n老大今天教我认星座。\n')
    const r = await run(h.tools.get('recall_diary'), { query: '星座' })
    expect(r.message).toContain('【给老大的日记 · 2026-10-01 20:00】')
  })

  it('配置不合法时启动就报错', () => {
    expect(() => apply(fakeHost().ctx, { seedPath: seed, lifeDir: life, variablePrefix: 'Her-1' })).toThrow('variablePrefix')
    expect(() => apply(fakeHost().ctx, { seedPath: seed, lifeDir: life, ownerBook: 'private' })).toThrow('ownerBook')
  })
})
