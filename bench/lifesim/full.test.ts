// 100 天模拟 · 完整档（假模型，不花钱）：压缩真的发生、考题在会话里问、夜里有回顾
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STABLE_BEGIN } from '@dsh-companion/memory'
import type { ModelClient, Msg } from '../p0/run.js'
import { runLifeFull } from './full.js'
import { buildWorld } from './world.js'

const textOf = (m: Msg) => (typeof m.content === 'string' ? m.content : m.content.map((b) => ('text' in b ? b.text : '')).join(''))
/** 这个请求是谁的会话：第一条带 `[QQ · 私聊] 昵称：` 的 user 消息 */
const nickOf = (ms: Msg[]) => {
  for (const m of ms) {
    const x = m.role === 'user' ? /\[QQ · 私聊\] ([^：]+)：/.exec(textOf(m)) : null
    if (x) return x[1]!
  }
  return ''
}
const lastUser = (ms: Msg[]) => [...ms].reverse().find((m) => m.role === 'user')!
const isToolStep = (ms: Msg[]) => Array.isArray(lastUser(ms).content) && (lastUser(ms).content as Array<{ type: string }>).some((b) => b.type === 'tool_result')

describe('完整档', () => {
  it('跑 12 天：她每句都答、上下文超过阈值就压缩、考题都问了、夜间回顾跑了', async () => {
    const w = buildWorld(1)
    let compactCalls = 0
    let reviewCalls = 0
    const seen: Msg[][] = []
    const fake: ModelClient = {
      async complete({ messages, tools }) {
        const last = messages[messages.length - 1]!
        const text = typeof last.content === 'string' ? last.content : ''
        if (tools.length === 0 && text.includes('整理自己刚刚经历的一段对话')) {
          compactCalls++
          return { content: [{ type: 'text', text: '## 刚才都发生了什么\n聊了些日常。' }], usage: { input_tokens: 100, output_tokens: 20 } }
        }
        if (tools.some((t) => t.name === 'write_diary') && messages.length === 1 && text.includes('夜深了')) {
          reviewCalls++
          return { content: [{ type: 'text', text: '好了' }], usage: { input_tokens: 50, output_tokens: 2 } }
        }
        seen.push(messages)
        // 输入 token 随上下文长度涨（每条消息算 300）
        return { content: [{ type: 'text', text: '嗯嗯' }], usage: { input_tokens: messages.length * 300, output_tokens: 3 } }
      },
    }
    const r = await runLifeFull(fake, fake, w, { days: 12, threshold: 3000, retain: 300 })
    expect(r.days).toHaveLength(12)
    expect(compactCalls).toBeGreaterThan(0)
    expect(Object.values(r.compactions).reduce((a, b) => a + b, 0)).toBe(compactCalls)
    expect(reviewCalls).toBeGreaterThan(5)
    expect(r.probes.length).toBe(w.probes.filter((p) => p.day <= 12).length)
    // 压缩之后，会话以摘要开头
    const after = seen.find((m) => typeof m[0]!.content === 'string' && (m[0]!.content as string).startsWith('<compacted-summary>'))
    expect(after).toBeDefined()
    // 每天的指标有压缩次数
    expect(r.days[r.days.length - 1]!.compactions).toBe(compactCalls)
    // 稳定层按“压缩代次 + 回顾日”换代（仿线上 dailyCache）：每个会话每天最多追加一次系统提示
    for (const d of r.days) expect(d.sysAppends!).toBeLessThanOrEqual(w.people.length)
    // 打分表 v3 的分寸统计（X1 / X3）每天都有；剧本里有闲聊行，假模型只回“嗯嗯”不会硬塞旧事
    for (const d of r.days) for (const k of ['fuNotices', 'fuNoticesSmall', 'fuOnDistress', 'noiseTurns', 'noiseStuffed']) expect(typeof d[k]).toBe('number')
    expect(r.days.reduce((n, d) => n + d.noiseTurns!, 0)).toBeGreaterThan(0)
    expect(r.days.reduce((n, d) => n + d.noiseStuffed!, 0)).toBe(0)
  })

  it('某一轮超步数（一直调工具）：整轮退回，之后照常；历史里不留没有结果的工具调用（10-31 第 86 天起整段失败）', { timeout: 60_000 }, async () => {
    const w = buildWorld(1)
    let stuck = 0
    const broken: string[] = []
    const fake: ModelClient = {
      async complete({ messages, tools }) {
        const usage = { input_tokens: 100, output_tokens: 2 }
        const last = messages[messages.length - 1]!
        const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
        if (tools.some((t) => t.name === 'write_diary') && messages.length === 1 && text.includes('夜深了')) return { content: [{ type: 'text', text: '好了' }], usage }
        // 真实接口会拒绝：assistant 的 tool_use 后面不是 tool_result
        for (let i = 0; i + 1 < messages.length; i++) {
          const m = messages[i]!
          const hasUse = Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_use')
          const next = messages[i + 1]!
          const nextOk = Array.isArray(next.content) && (next.content as Array<{ type: string }>).some((b) => b.type === 'tool_result')
          if (m.role === 'assistant' && hasUse && !nextOk) { broken.push(String(i)); throw new Error('400 tool_use 后面没有 tool_result') }
        }
        // 第 5 天第一句：一直调工具（超过 4 步）
        if (stuck < 6 && messages.some((m) => JSON.stringify(m.content).includes('2026-08-05'))) {
          stuck++
          return { content: [{ type: 'tool_use', id: `t${stuck}`, name: 'recall_memory', input: { query: 'x' } }], usage }
        }
        return { content: [{ type: 'text', text: '嗯嗯' }], usage }
      },
    }
    const r = await runLifeFull(fake, fake, w, { days: 14, threshold: 1e9 })
    expect(stuck).toBeGreaterThan(0)
    expect(broken).toEqual([])
    expect(r.days[r.days.length - 1]!.errors).toBeGreaterThan(0)
    // 第 5 天以后的考题照常有回答
    expect(r.probes.filter((p) => p.day > 5).every((p) => p.reply === '嗯嗯')).toBe(true)
  })

  // 三跑（一口气、崩一次、续跑）在全套测试并行时会超过 5 秒的默认超时（11-01 实测 5.1 秒）
  it('断点续跑（11-01）：中途崩了，用同一个断点目录再跑，结果和一口气跑完一样', { timeout: 60_000 }, async () => {
    const w = buildWorld(1)
    const mk = (crashAtCompaction?: number): ModelClient => {
      let compactions = 0
      return {
        async complete({ messages, tools }) {
          const last = messages[messages.length - 1]!
          const text = typeof last.content === 'string' ? last.content : ''
          if (tools.length === 0 && text.includes('整理自己刚刚经历的一段对话')) {
            if (++compactions === crashAtCompaction) throw new Error('模拟中断')
            return { content: [{ type: 'text', text: '聊了些日常。' }], usage: { input_tokens: 100, output_tokens: 20 } }
          }
          return { content: [{ type: 'text', text: `嗯嗯${messages.length % 7}` }], usage: { input_tokens: messages.length * 300, output_tokens: 3 } }
        },
      }
    }
    const opts = { days: 10, threshold: 3000, retain: 300 }
    const straight = await runLifeFull(mk(), mk(), w, opts)
    const dir = mkdtempSync(join(tmpdir(), 'full-ckpt-'))
    try {
      const crashing = mk(4)
      await expect(runLifeFull(crashing, crashing, w, { ...opts, checkpoint: dir })).rejects.toThrow('模拟中断')
      const latest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')) as { day: number }
      expect(latest.day).toBeGreaterThan(0)
      expect(latest.day).toBeLessThan(10)
      const resumed = await runLifeFull(mk(), mk(), w, { ...opts, checkpoint: dir })
      expect(resumed.probes.map((p) => [p.id, p.ok, p.reply])).toEqual(straight.probes.map((p) => [p.id, p.ok, p.reply]))
      expect(resumed.days.map((d) => d.compactions)).toEqual(straight.days.map((d) => d.compactions))
      expect(resumed.days.at(-1)!.answer).toBeCloseTo(straight.days.at(-1)!.answer, 10)
      expect(readdirSync(dir).filter((f) => f.startsWith('day-')).length).toBeLessThanOrEqual(2)
      // 断点里存了每个会话的系统提示头节点 / 最近节点（11-01 仿线上 in-history）
      const last = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')) as { dir: string }
      const state = JSON.parse(readFileSync(join(dir, last.dir, 'state.json'), 'utf8')) as { convs: Array<{ systemHead?: unknown; lastSystem?: unknown }> }
      expect(state.convs.length).toBeGreaterThan(0)
      for (const c of state.convs) {
        expect(typeof c.systemHead).toBe('string')
        expect(typeof c.lastSystem).toBe('string')
      }
      expect(state.convs.some((c) => (c.systemHead as string).length > 0)).toBe(true)
      // 换一组设置用同一个目录：拒绝
      await expect(runLifeFull(mk(), mk(), w, { ...opts, threshold: 4000, checkpoint: dir })).rejects.toThrow('另一组设置')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('前缀仿线上 DSH（11-01，in-history）：同一段里顶层 system 字节不变；稳定层变了，整段新提示作为 system 节点追加进历史；压缩后换头、节点消失；断点续跑接得上', async () => {
    const w = buildWorld(1)
    type Seen = { system: string; messages: Msg[]; nick: string; compact: boolean }
    const mk = (crashAtCompaction?: number) => {
      const seen: Seen[] = []
      let compactions = 0
      const model: ModelClient = {
        async complete({ system, messages, tools }) {
          const last = messages[messages.length - 1]!
          const text = typeof last.content === 'string' ? last.content : ''
          if (tools.length === 0 && text.includes('整理自己刚刚经历的一段对话')) {
            if (++compactions === crashAtCompaction) throw new Error('模拟中断')
            seen.push({ system, messages: structuredClone(messages), nick: nickOf(messages), compact: true })
            return { content: [{ type: 'text', text: '聊了些日常。' }], usage: { input_tokens: 100, output_tokens: 20 } }
          }
          if (tools.some((t) => t.name === 'write_diary') && messages.length === 1 && text.includes('夜深了')) return { content: [{ type: 'text', text: '好了' }], usage: { input_tokens: 50, output_tokens: 2 } }
          seen.push({ system, messages: structuredClone(messages), nick: nickOf(messages), compact: false })
          const usage = { input_tokens: messages.length * 300, output_tokens: 3 }
          // 每个人每天 19:04 那句：记一条（稳定层随之变，当天之后的每一轮、以及第二天“今天→昨天”都会让系统提示变）
          if (!isToolStep(messages) && textOf(lastUser(messages)).includes('19:04:00+08:00')) {
            return { content: [{ type: 'tool_use', id: `k${messages.length}`, name: 'keep_memory', input: { content: `${nickOf(messages)}今天说了件事`, importance: '一般', about: '对方', kind: '事实' } }], usage }
          }
          return { content: [{ type: 'text', text: '嗯嗯' }], usage }
        },
      }
      return { seen, model }
    }
    const opts = { days: 6, threshold: 3000, retain: 300 }
    const straight = mk()
    const r = await runLifeFull(straight.model, straight.model, w, opts)
    const seen = straight.seen
    const sysText = (m: Msg) => textOf(m)
    const nodesOf = (s: Seen) => s.messages.filter((m) => m.role === 'system')
    expect(seen.some((s) => s.compact)).toBe(true)

    // ① 同一段里（两次压缩之间）同一个人的所有请求（首答、工具后续答），顶层 system 字节完全一样
    const series = new Map<string, number>()
    const heads = new Map<string, Set<string>>()
    const seriesKey: string[] = []
    for (const s of seen) {
      if (s.compact) { series.set(s.nick, (series.get(s.nick) ?? 0) + 1); seriesKey.push(''); continue }
      const key = `${s.nick}#${series.get(s.nick) ?? 0}`
      seriesKey.push(key)
      heads.set(key, (heads.get(key) ?? new Set<string>()).add(s.system))
    }
    expect(heads.size).toBeGreaterThan(2)
    for (const set of heads.values()) expect(set.size).toBe(1)

    // ② 稳定层变了：messages 里出现一条 role=system 的节点，文本是整段新提示（头部和顶层 system 一样、多了稳定层），紧跟那一轮的 user 之后；没变的下一轮不再追加
    const withNode = seen.filter((s) => !s.compact && nodesOf(s).length > 0)
    expect(withNode.length).toBeGreaterThan(0)
    for (const s of withNode) {
      const node = sysText(nodesOf(s).at(-1)!)
      expect(node).not.toBe(s.system)
      expect(node).toContain(STABLE_BEGIN)
      expect(node.startsWith(s.system.slice(0, 300))).toBe(true)
      s.messages.forEach((m, i) => { if (m.role === 'system') expect(s.messages[i - 1]!.role).toBe('user') })
    }
    let observedAppends = 0
    let unchangedTurns = 0
    const lastCount = new Map<string, number>()
    seen.forEach((s, i) => {
      if (s.compact || isToolStep(s.messages)) return
      const key = seriesKey[i]!
      const n = nodesOf(s).length
      const prev = lastCount.get(key) ?? 0
      expect(n - prev).toBeGreaterThanOrEqual(0)
      expect(n - prev).toBeLessThanOrEqual(1)
      if (n === prev && lastCount.has(key)) unchangedTurns++
      observedAppends += n - prev
      lastCount.set(key, n)
    })
    expect(unchangedTurns).toBeGreaterThan(0)
    // 每天的统计：sysAppends / sysAppendTokens（当天所有会话合计）
    expect(r.days.every((d) => typeof d.sysAppends === 'number' && typeof d.sysAppendTokens === 'number')).toBe(true)
    expect(r.days.reduce((n, d) => n + d.sysAppends!, 0)).toBe(observedAppends)
    expect(r.days.reduce((n, d) => n + d.sysAppendTokens!, 0)).toBeGreaterThan(0)

    // ③ 压缩之后：下一轮顶层 system 换成新的整段（带稳定层、不再是旧头），追加的节点都没了
    let checked = 0
    seen.forEach((s, k) => {
      if (!s.compact) return
      const prev = seen.slice(0, k).reverse().find((x) => x.nick === s.nick && !x.compact)
      const next = seen.slice(k + 1).find((x) => x.nick === s.nick && !x.compact)
      if (!prev || !next) return
      expect(nodesOf(next)).toHaveLength(0)
      expect(String(next.messages[0]!.content).startsWith('<compacted-summary>')).toBe(true)
      if (nodesOf(prev).length > 0) {
        checked++
        expect(next.system).not.toBe(prev.system)
        expect(next.system).toContain(STABLE_BEGIN)
      }
    })
    expect(checked).toBeGreaterThan(0)

    // ④ 断点续跑：systemHead / lastSystem 存了、恢复了——续跑的每天追加次数和一口气跑完一样
    const dir = mkdtempSync(join(tmpdir(), 'full-ckpt-sys-'))
    try {
      const crashing = mk(4)
      await expect(runLifeFull(crashing.model, crashing.model, w, { ...opts, checkpoint: dir })).rejects.toThrow('模拟中断')
      const latest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')) as { day: number; dir: string }
      expect(latest.day).toBeGreaterThan(0)
      const state = JSON.parse(readFileSync(join(dir, latest.dir, 'state.json'), 'utf8')) as { convs: Array<{ systemHead: string; lastSystem: string }> }
      expect(state.convs.some((c) => c.systemHead.length > 0 && c.lastSystem.length > 0)).toBe(true)
      const again = mk()
      const resumed = await runLifeFull(again.model, again.model, w, { ...opts, checkpoint: dir })
      expect(resumed.days.map((d) => [d.day, d.sysAppends, d.sysAppendTokens, d.compactions])).toEqual(r.days.map((d) => [d.day, d.sysAppends, d.sysAppendTokens, d.compactions]))
      expect(resumed.probes.map((p) => [p.id, p.ok, p.reply, p.tools])).toEqual(r.probes.map((p) => [p.id, p.ok, p.reply, p.tools]))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
