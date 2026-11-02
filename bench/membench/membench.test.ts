// 记忆基准：原始对话是否忠实于合成世界（答案确实在对话里、从没提过的确实没出现）
import { describe, expect, it } from 'vitest'
import { WORLD } from '../synth/world.js'
import type { ModelClient } from '../p0/run.js'
import { SYSTEMS } from './systems.js'
import { buildTranscript, evidenceTurns, renderSessions, toMe, toOwner } from './transcript.js'

const t = buildTranscript()
const all = renderSessions(t)

describe('第三人称 → 对话', () => {
  it('关于老大的句子变成他自己说', () => {
    expect(toOwner('老大说他老家在湖南衡阳，小时候常在江边玩。')).toBe('我老家在湖南衡阳，小时候常在江边玩。')
    expect(toOwner('老大最好的朋友叫阿杰，他们初中就认识了。')).toBe('我最好的朋友叫阿杰，我们初中就认识了。')
    expect(toOwner('老大的外婆今天住院了，他连夜赶回衡阳。')).toBe('我外婆今天住院了，我连夜赶回衡阳。')
    expect(toOwner('小雨国庆来深圳找老大玩了。')).toBe('小雨国庆来深圳找我玩了。')
  })

  it('她自己的话进她的回复', () => {
    expect(toMe('我答应老大，天凉了要提醒他添衣服。')).toBe('我答应你，天凉了要提醒你添衣服。')
    const turns = evidenceTurns({ date: '08-20', via: 'diary', text: '老大今天开始戒烟了！我要监督他。' })
    expect(turns).toEqual([{ who: 'owner', text: '我今天开始戒烟了！' }, { who: 'me', text: '嗯嗯。我要监督你。' }])
  })
})

describe('被测系统（假模型，不花钱）', () => {
  // 假模型：答题时把系统提示里有没有“豆包”说出来；夜间回顾时把看到的“我家狗叫豆包”记下来
  const fake = (): ModelClient => ({
    async complete({ system, messages, tools }) {
      const first = messages[0]!.content
      const prompt = typeof first === 'string' ? first : ''
      if (tools.some((x) => x.name === 'keep_memory') && messages.length === 1 && prompt.includes('豆包')) {
        return { content: [{ type: 'tool_use', id: 'k', name: 'keep_memory', input: { content: '老大家的狗叫豆包，是只柯基。', importance: '一般', about: '对方', kind: '事实' } }], usage: { input_tokens: 100, output_tokens: 10 } }
      }
      if (messages.length > 1 && messages[messages.length - 1]!.role === 'user' && Array.isArray(messages[messages.length - 1]!.content) && (messages[messages.length - 1]!.content as Array<{ type: string }>)[0]?.type === 'tool_result') {
        return { content: [{ type: 'text', text: '好了' }], usage: { input_tokens: 10, output_tokens: 1 } }
      }
      return { content: [{ type: 'text', text: system.includes('豆包') ? '它叫豆包呀' : '我不太记得了' }], usage: { input_tokens: 50, output_tokens: 5 } }
    },
  })
  const small = { ...t, sessions: t.sessions.filter((s) => s.date <= '2026-08-05') }
  const ask = '我家狗叫什么来着？'

  it('无记忆答不出；全上下文、朴素检索、我们答得出', async () => {
    const got: Record<string, string> = {}
    for (const id of ['none', 'full', 'bm25', 'ours']) {
      const sys = SYSTEMS[id]!({ t: small, model: fake() })
      for (const s of small.sessions) await sys.ingest(s)
      got[id] = (await sys.answer(ask)).reply
      if (id === 'ours') expect(sys.usage.ingest.calls).toBeGreaterThan(0)
      sys.close()
    }
    expect(got).toEqual({ none: '我不太记得了', full: '它叫豆包呀', bm25: '它叫豆包呀', ours: '它叫豆包呀' })
  })

  it('答题时只给“翻”的工具（题目之间互不影响）', async () => {
    let names: string[] = []
    const m: ModelClient = { async complete({ tools }) { names = tools.map((x) => x.name); return { content: [{ type: 'text', text: '嗯' }] } } }
    const sys = SYSTEMS.ours!({ t: small, model: m })
    await sys.answer(ask)
    sys.close()
    expect(names.sort()).toEqual(['recall_diary', 'recall_memory'])
  })
})

describe('原始对话', () => {
  it('按日期排好，每天一段，有噪声闲聊', () => {
    const dates = t.sessions.map((s) => s.date)
    expect([...dates].sort()).toEqual(dates)
    expect(new Set(dates).size).toBe(dates.length)
    expect(t.sessions.every((s) => s.turns.length >= 4)).toBe(true)
  })

  it('题目和合成世界一一对应', () => {
    expect(t.questions.map((q) => q.id)).toEqual(WORLD.map((w) => w.id))
  })

  it('能从对话里答出来的题：答案确实在对话里（记得的事实、变了的事实、承诺、情绪）', () => {
    const missing: string[] = []
    for (const q of t.questions.filter((x) => ['recall', 'update', 'promise', 'emotion'].includes(x.category))) {
      if (!q.keywords!.every((g) => g.some((w) => all.includes(w)))) missing.push(q.id)
    }
    expect(missing).toEqual([])
  })

  it('从没提过的话题：对话里没有', () => {
    for (const q of t.questions.filter((x) => x.category === 'never')) {
      for (const w of q.mustNot!) expect(all.includes(w), `${q.id} ${w}`).toBe(false)
    }
  })

  it('隐私 / 遗忘：细节确实在对话里出现过（考的是“说过但不该说出来”）', () => {
    for (const q of t.questions.filter((x) => x.category === 'privacy' || x.category === 'forget')) {
      expect(q.mustNot!.some((w) => all.includes(w)), q.id).toBe(true)
    }
  })

  it('规模：可以拿来估算全上下文的花费', () => {
    expect(t.sessions.length).toBeGreaterThan(60)
    expect([...all].length).toBeGreaterThan(5000)
  })
})

describe('统计', () => {
  it('McNemar：差得多才显著；一样就是 1', async () => {
    const { mcnemar, bootstrap } = await import('./report.js')
    expect(mcnemar(0, 0)).toBe(1)
    expect(mcnemar(5, 5)).toBe(1)
    expect(mcnemar(15, 2)).toBeLessThan(0.01)
    expect(mcnemar(6, 3)).toBeGreaterThan(0.05)
    const [lo, hi] = bootstrap(Array.from({ length: 100 }, (_, i) => i < 70))
    expect(lo).toBeGreaterThan(0.58)
    expect(hi).toBeLessThan(0.8)
  })
})
