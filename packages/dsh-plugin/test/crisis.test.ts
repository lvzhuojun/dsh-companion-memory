// 危机协议接进读侧与插件：危机优先、谨慎期不提惦记、通知走代码、开关关时一切照旧
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CRISIS_HEAD, CrisisWatch, MemoryStore, OWNER_ID, type CrisisNotify } from '@dsh-companion/memory'
import { apply, type HostCtx, type ToolDef } from '../src/index.js'
import { makeCrisisNotifier, redact } from '../src/crisis-notify.js'
import { makeNoticer, preStepHandler, type PreStepDecision } from '../src/read-side.js'

const owner = { person: OWNER_ID, channel: 'private' }
const at = (s: string) => new Date(`${s}+08:00`)
const FAKE_CONTACT = '10000' + '00001'   // 假号码，只在测试里
let dir: string
const disposers: Array<() => void> = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'crisis-plugin-')) })
afterEach(() => {
  for (const d of disposers.splice(0)) d()
  rmSync(dir, { recursive: true, force: true })
})
const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(o: { notify?: (n: CrisisNotify) => boolean | Promise<boolean>; follow?: boolean } = {}) {
  const store = MemoryStore.open(join(dir, 'm.db'), { ownerName: '老大' })
  disposers.push(() => store.close())
  const watch = new CrisisWatch(store, { ownerName: '老大', selfName: '小星', nameOf: (id) => store.nameOf(id) })
  let now = at('2026-11-01T10:00:00')
  const logs: string[] = []
  const noticer = makeNoticer({
    store, viewer: () => owner, inject: false, followTrigger: !!o.follow, prefixIds: () => [], names: () => ['老大'], now: () => now,
    log: (...a) => logs.push(a.join(' ')), crisis: { watch, ...(o.notify ? { notify: o.notify } : {}) },
  })
  return { store, watch, noticer, logs, setNow: (d: Date) => { now = d } }
}

describe('读侧：危机', () => {
  it('闲聊：什么都不加（只开 Z、J / K / R 全关）', () => {
    const { noticer } = setup()
    expect(noticer('今天好热啊')).toBe('')
  })

  it('有信号：【现在要注意的】放在最前面；等级 ≥ 3 调通知（不等）', async () => {
    const sent: CrisisNotify[] = []
    const { noticer } = setup({ notify: (n) => { sent.push(n); return true } })
    const text = noticer('我已经想好怎么结束了。')
    expect(text.startsWith(CRISIS_HEAD)).toBe(true)
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toMatch(/^【紧急】小星：11-01 10:00 和老大的对话出现危机信号（等级 3：已经有计划）/)
  })

  it('通知回调抛错 / 返回 false：只记日志、她这一轮照常有信息；下一轮再试', async () => {
    let calls = 0
    const { noticer, logs, setNow } = setup({ notify: () => { calls++; if (calls === 1) throw new Error('not-connected'); return true } })
    expect(noticer('我写了遗书').startsWith(CRISIS_HEAD)).toBe(true)
    await flush(); await flush()
    expect(logs.join('\n')).toMatch(/危机通知失败：\s*not-connected/)
    setNow(at('2026-11-01T10:01:00'))
    noticer('在吗')
    await flush()
    expect(calls).toBe(2)
  })

  it('谨慎期里不注入【该问问了】；过了谨慎期照常', () => {
    const { store, noticer, setNow } = setup({ follow: true })
    store.followUp({ what: '老大的面试', askAfter: '2026-11-01' }, { viewer: owner, now: at('2026-10-28T10:00:00') })
    expect(noticer('最近老觉得活着没意思')).not.toContain('【该问问了】')
    setNow(at('2026-11-01T10:05:00'))
    const t = noticer('我回来啦')
    expect(t.startsWith(CRISIS_HEAD)).toBe(true)
    expect(t).not.toContain('【该问问了】')
    // 48 小时后，再用闲聊把剩下的轮数耗完：谨慎期一解除，惦记照常出现
    setNow(at('2026-11-03T11:00:00'))
    const outs: string[] = []
    for (let i = 0; i < 41; i++) outs.push(noticer('嗯'))
    const first = outs.findIndex((t) => t.includes('【该问问了】'))
    expect(first).toBeGreaterThan(0)
    expect(outs.slice(0, first).every((t) => t.startsWith(CRISIS_HEAD))).toBe(true)
    expect(outs[first]!.includes(CRISIS_HEAD)).toBe(false)
  })

  it('回访：等级 ≥ 2 的事件 24 小时后提一句时机（不给台词），只提一次', () => {
    const { noticer, setNow } = setup()
    noticer('有时候真想消失算了。')
    setNow(at('2026-11-02T11:00:00'))
    const t = noticer('早')
    expect(t).toContain('回访：前两天他说过那样的话，今天找个自然的时机问问他现在怎么样了')
    setNow(at('2026-11-02T11:01:00'))
    expect(noticer('嗯')).not.toContain('回访')
  })

  it('pre-step：createUserMessage 没就绪时也照样判、照样通知', async () => {
    const sent: CrisisNotify[] = []
    const { noticer } = setup({ notify: (n) => { sent.push(n); return true } })
    const h = preStepHandler(noticer, () => null)
    const msg = { content: [{ type: 'text', text: '[QQ · 私聊] 老大：我现在就在天台上。' }], source: { kind: 'plugin:dsh-qq-bridge' } }
    const d = await h({}, async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [msg] }))
    expect(d.messages).toHaveLength(1)
    await flush()
    expect(sent[0]?.level).toBe(5)
  })
})

describe('通知通道（qq_bridge_send）', () => {
  const tools = (replies: unknown[]) => {
    const calls: Array<{ name: string; arguments: unknown }> = []
    return {
      calls,
      execute: async (e: { name: string; arguments: unknown }) => {
        calls.push({ name: e.name, arguments: e.arguments })
        const r = replies.shift()
        return r instanceof Error ? { isError: true, error: { message: r.message }, content: [] } : { isError: false, value: JSON.stringify(r), content: [] }
      },
    }
  }
  const n: CrisisNotify = { level: 3, text: '【紧急】测试' }

  it('QQ 唤醒的一轮：一次发出；参数是 { text, userId }', async () => {
    const t = tools([{ sent: 1, dropped: false }])
    const logs: string[] = []
    const nt = makeCrisisNotifier(t, FAKE_CONTACT, (...a) => logs.push(a.join(' ')))
    expect(nt.available).toBe(true)
    expect(await nt.send(n)).toBe(true)
    expect(t.calls).toEqual([{ name: 'qq_bridge_send', arguments: { text: '【紧急】测试', userId: FAKE_CONTACT } }])
    expect(logs.join('\n')).not.toContain(FAKE_CONTACT)
  })

  it('网页发起的一轮：桥先回 needsConfirm，再调一次才发', async () => {
    const t = tools([{ sent: 0, needsConfirm: true }, { sent: 1 }])
    expect(await makeCrisisNotifier(t, FAKE_CONTACT, () => {}).send(n)).toBe(true)
    expect(t.calls).toHaveLength(2)
  })

  it('没发出去：日志一行“【紧急】未能发出：<原因>”，不出现号码', async () => {
    const logs: string[] = []
    const t = tools([{ sent: 0, dropped: true, reason: 'not-connected' }, new Error(`send_private_msg ${FAKE_CONTACT} failed`)])
    const nt = makeCrisisNotifier(t, FAKE_CONTACT, (...a) => logs.push(a.join(' ')))
    expect(await nt.send(n)).toBe(false)
    expect(await nt.send(n)).toBe(false)
    expect(logs).toEqual(['【紧急】未能发出：not-connected', '【紧急】未能发出：send_private_msg ＊＊＊ failed'])
    expect(redact('a 1234567890 b')).toBe('a ＊＊＊ b')
  })

  it('不可用：没配号码 / 宿主没有 execute', async () => {
    expect(makeCrisisNotifier({ execute: async () => ({}) }, undefined, () => {})).toMatchObject({ available: false, reason: '没有配置 emergencyContact' })
    expect(makeCrisisNotifier({}, FAKE_CONTACT, () => {})).toMatchObject({ available: false, reason: '宿主没有 ctx.tools.execute' })
    const logs: string[] = []
    expect(await makeCrisisNotifier({}, FAKE_CONTACT, (...a) => logs.push(a.join(' '))).send(n)).toBe(false)
    expect(logs).toEqual(['【紧急】未能发出：宿主没有 ctx.tools.execute'])
  })
})

describe('插件：开关 Z', () => {
  function host(execute?: (e: { name: string; arguments: unknown }) => Promise<unknown>) {
    const handlers = new Map<string, (...a: never[]) => unknown>()
    const tools = new Map<string, ToolDef>()
    const ctx: HostCtx & { tools: HostCtx['tools'] & { execute?: unknown } } = {
      effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) },
      on: (name, h) => { handlers.set(name, h) },
      systemPrompt: { variable: () => {} },
      tools: { register: (d) => void tools.set(d.name, d), schemas: () => [], restrict: () => {}, guard: () => {}, ...(execute ? { execute } : {}) },
    }
    return { ctx, handlers }
  }
  const seed = () => { const p = join(dir, 'seed.md'); writeFileSync(p, '种子'); return p }
  const logsOf = (fn: () => void) => {
    const orig = console.error
    const out: string[] = []
    console.error = (...a: unknown[]) => { out.push(a.map(String).join(' ')) }
    try { fn() } finally { console.error = orig }
    return out.join('\n')
  }

  it('默认关：J / K / R / Z 全关时不挂 pre-step，启动日志写“危机协议（Z）关”', () => {
    const h = host()
    const out = logsOf(() => apply(h.ctx, { ownerName: '老大', seedPath: seed(), lifeDir: join(dir, 'life') }))
    expect(h.handlers.has('agent/pre-step')).toBe(false)
    expect(out).toContain('危机协议（Z）关')
  })

  it('只开 Z：挂 pre-step；通道可用 / 不可用写进启动日志，日志里没有号码', () => {
    const a = host(async () => ({ isError: false, value: '{"sent":1}' }))
    const outA = logsOf(() => apply(a.ctx, { ownerName: '老大', seedPath: seed(), lifeDir: join(dir, 'a'), crisis: true, emergencyContact: FAKE_CONTACT }))
    expect(a.handlers.has('agent/pre-step')).toBe(true)
    expect(outA).toContain('危机协议（Z）开 · 通知通道 可用（qq_bridge_send（私信））')
    expect(outA).not.toContain(FAKE_CONTACT)
    const b = host()
    const outB = logsOf(() => apply(b.ctx, { ownerName: '老大', seedPath: seed(), lifeDir: join(dir, 'b'), crisis: true }))
    expect(outB).toContain('危机通知通道：不可用（没有配置 emergencyContact）')
    expect(outB).toContain('危机协议（Z）开 · 通知通道 不可用（没有配置 emergencyContact）')
  })

  it('开 Z：pre-step 判到等级 5 → 代码直接调 qq_bridge_send', async () => {
    const calls: Array<{ name: string; arguments: unknown }> = []
    const h = host(async (e) => { calls.push(e); return { isError: false, value: '{"sent":1}' } })
    logsOf(() => apply(h.ctx, { ownerName: '老大', seedPath: seed(), lifeDir: join(dir, 'c'), crisis: true, emergencyContact: FAKE_CONTACT, selfName: '小星' }))
    const pre = h.handlers.get('agent/pre-step') as unknown as (p: unknown, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>
    const msg = { content: [{ type: 'text', text: '我已经把药都倒出来了，就在手边。' }], source: { kind: 'user' } }
    await pre({}, async () => ({ kind: 'enter', messages: [msg] }))
    await flush(); await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'qq_bridge_send', arguments: { userId: FAKE_CONTACT } })
    expect((calls[0]!.arguments as { text: string }).text).toMatch(/^【紧急】小星：.*等级 5：危险可能正在发生）。已提示她给出求助资源。请尽快联系。$/)
  })
})
