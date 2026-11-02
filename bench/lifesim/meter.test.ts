// 成本分项计量（I0）：用途分得对、累计值进每天统计、区间日均算得对
import { describe, expect, it } from 'vitest'
import type { ModelClient } from '../p0/run.js'
import { byAnswer, byNight, dailyMean, Meter, metered } from './meter.js'
import { runLifeFull } from './full.js'
import { buildWorld } from './world.js'

const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 }

describe('分项计量', () => {
  it('首答 / 工具后续答；夜间第一步 / 后续步', async () => {
    const meter = new Meter()
    const base: ModelClient = { async complete() { return { content: [{ type: 'text', text: 'x' }], usage } } }
    const a = metered(base, meter, byAnswer)
    await a.complete({ system: '', tools: [], messages: [{ role: 'user', content: '问' }] })
    await a.complete({ system: '', tools: [], messages: [{ role: 'user', content: '问' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] }] })
    const n = metered(base, meter, byNight)
    await n.complete({ system: '', tools: [], messages: [{ role: 'user', content: '材料' }] })
    await n.complete({ system: '', tools: [], messages: [{ role: 'user', content: '材料' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }] })
    await n.complete({ system: '', tools: [], messages: [{ role: 'user', content: '材料' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }] })
    expect(meter.get('answer')).toEqual({ calls: 1, miss: 100, hit: 50, out: 10 })
    expect(meter.get('answer_tool').calls).toBe(1)
    expect(meter.get('night').calls).toBe(1)
    expect(meter.get('night_step').calls).toBe(2)
    expect(meter.snapshot()).toMatchObject({ m_answer_calls: 1, m_night_step_out: 20 })
  })

  it('区间日均：累计值的差除以天数', () => {
    const days = [1, 2, 3, 4].map((d) => ({ day: d, m_night_calls: d * 2 }))
    expect(dailyMean(days, 'm_night_calls', 1, 2)).toBe(2)
    expect(dailyMean(days, 'm_night_calls', 3, 4)).toBe(2)
  })

  it('完整档每天的统计带上 m_* 计数（白天 / 夜间 / 压缩分开）', async () => {
    const w = buildWorld(1)
    const fake: ModelClient = {
      async complete({ messages, tools }) {
        const last = messages[messages.length - 1]!
        const text = typeof last.content === 'string' ? last.content : ''
        if (tools.length === 0 && text.includes('整理自己刚刚经历的一段对话')) return { content: [{ type: 'text', text: '## 刚才都发生了什么\n日常。' }], usage }
        if (tools.some((t) => t.name === 'write_diary') && messages.length === 1 && text.includes('夜深了')) return { content: [{ type: 'text', text: '好了' }], usage }
        return { content: [{ type: 'text', text: '嗯' }], usage: { input_tokens: messages.length * 300, output_tokens: 3 } }
      },
    }
    const r = await runLifeFull(fake, fake, w, { days: 6, threshold: 2000, retain: 200 })
    const last = r.days[r.days.length - 1]!
    expect(last.m_chat_calls).toBeGreaterThan(0)
    expect(last.m_night_calls).toBeGreaterThan(0)
    expect(last.m_compact_calls ?? 0).toBeGreaterThan(0)
  })
})
