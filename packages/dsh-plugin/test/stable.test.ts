// 插件层：稳定层进系统提示（按天缓存）、follow_up 工具、规则
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STABLE_BEGIN, STABLE_END } from '@dsh-companion/memory'
import { apply, dailyCache, memoryRules, type HerLifeConfig, type HostCtx, type ToolDef } from '../src/index.js'

const disposers: Array<() => void> = []
function fakeHost() {
  const variables = new Map<string, () => string>()
  const tools = new Map<string, ToolDef>()
  const ctx: HostCtx = {
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
    },
    systemPrompt: { variable: (name, p) => void variables.set(name, p) },
    tools: { register: (def) => void tools.set(def.name, def), schemas: () => [...tools.keys()].map((name) => ({ name })), restrict: () => {}, guard: () => {} },
  }
  return { ctx, variables, tools }
}
const XJ: HerLifeConfig = { ownerName: '老大', ownerBook: 'to_laoda', variablePrefix: 'her', privateDiaryAudited: true }
const run = async (t: ToolDef | undefined, args: unknown) => (await t!.execute(args)) as { ok: boolean; message: string; id?: string }

let life: string
let seed: string
beforeEach(() => {
  life = mkdtempSync(join(tmpdir(), 'her-stable-'))
  seed = join(life, 'seed.md')
  writeFileSync(seed, '种子')
})
afterEach(() => {
  for (const d of disposers.splice(0)) d()
  rmSync(life, { recursive: true, force: true })
})
const mount = () => {
  const h = fakeHost()
  apply(h.ctx, { ...XJ, seedPath: seed, lifeDir: life })
  return h
}
const rules = memoryRules({ ownerName: '老大', privateDiaryAudited: true, memory: true })

describe('稳定层进系统提示', () => {
  it('什么都没记时 her_memory 只有规则（和以前一样）', () => {
    expect(mount().variables.get('her_memory')!()).toBe(rules)
  })

  it('记下的事：当天不变（不让前缀缓存失效），换一天（或重新挂载）后出现在规则后面', async () => {
    const h = mount()
    expect(h.variables.get('her_memory')!()).toBe(rules) // 宿主每个 step 都求值：挂载后第一步就生成了今天的
    await run(h.tools.get('keep_memory'), { content: '老大开一辆白色的比亚迪。', importance: '一般', about: '对方', kind: '事实' })
    expect(h.variables.get('her_memory')!()).toBe(rules)
    for (const d of disposers.splice(0)) d()
    const s = mount().variables.get('her_memory')!()
    expect(s.startsWith(rules + '\n\n' + STABLE_BEGIN)).toBe(true)
    expect(s).toContain('· 老大开一辆白色的比亚迪。（今天，老大亲口说的）')
    expect(s.endsWith(STABLE_END)).toBe(true)
  })

  it('dailyCache：同一天只生成一次；换天重新生成；生成出错时退回空串并报告', () => {
    let day = 'd1'
    let n = 0
    const c = dailyCache(() => `v${++n}`, () => day)
    expect([c(), c(), c()]).toEqual(['v1', 'v1', 'v1'])
    day = 'd2'
    expect(c()).toBe('v2')
    const errs: unknown[] = []
    const bad = dailyCache(() => { throw new Error('坏了') }, () => 'd1', (e) => errs.push(e))
    expect([bad(), bad()]).toEqual(['', ''])
    expect(errs).toHaveLength(1)
  })
})

describe('follow_up 工具', () => {
  it('惦记 → 问过了 → 有结果了；标掉之后不能再标', async () => {
    const h = mount()
    const t = h.tools.get('follow_up')
    const ask = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
    const a = await run(t, { action: '惦记', what: '老大的面试怎么样了', ask_after: ask })
    expect(a).toMatchObject({ ok: true })
    expect(a.message).toMatch(/惦记上了（编号 f_/)
    expect(await run(t, { action: '问过了', id: a.id })).toMatchObject({ ok: true, message: expect.stringContaining('等对方的回音') })
    expect(await run(t, { action: '有结果了', id: a.id, outcome: '面试过了' })).toMatchObject({ ok: true, message: expect.stringContaining('以后不再提') })
    expect(await run(t, { action: '问过了', id: a.id })).toMatchObject({ ok: false })
  })

  it('参数不对时告诉她怎么改', async () => {
    const t = mount().tools.get('follow_up')
    expect((await run(t, { action: '提醒' })).message).toContain('惦记 / 问过了 / 有结果了 / 不用再问')
    expect((await run(t, { action: '惦记', what: '面试', ask_after: '下周三' })).message).toContain('要写成日期')
    expect((await run(t, { action: '有结果了' })).message).toContain('编号')
  })

  it('问够两次：告诉她之后等对方自己提', async () => {
    const h = mount()
    const t = h.tools.get('follow_up')
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
    const a = await run(t, { action: '惦记', what: '体检结果', ask_after: today })
    await run(t, { action: '问过了', id: a.id })
    // 同一天再标不算第二次
    expect((await run(t, { action: '问过了', id: a.id })).message).toContain('问过 1 次')
  })
})

describe('规则', () => {
  it('记忆库开：说明“我心里记得的”怎么用、惦记的事怎么收尾；关掉时不提', () => {
    expect(rules).toContain('“我心里记得的”')
    expect(rules).toContain('follow_up')
    expect(rules).toContain('自己先说了结果')
    const off = memoryRules({ ownerName: '老大', privateDiaryAudited: true, memory: false })
    expect(off).not.toContain('我心里记得的')
    expect(off).not.toContain('follow_up')
  })
})

describe('第二阶段开关（默认关 = 0.4.0）', () => {
  it('C 该翻就翻、D 时间：开了才出现，关着规则和 0.4.0 一字不差', () => {
    const base = memoryRules({ ownerName: '老大', privateDiaryAudited: true, memory: true })
    expect(memoryRules({ ownerName: '老大', privateDiaryAudited: true, memory: true, askFirst: false, timeCalc: false })).toBe(base)
    const on = memoryRules({ ownerName: '老大', privateDiaryAudited: true, memory: true, askFirst: true, timeCalc: true })
    expect(on).toContain('这是在考我记不记得，不是闲聊')
    expect(on).toContain('按写着的日期和今天的日期一步步算出来')
    expect(base).not.toContain('一步步算')
  })
})
