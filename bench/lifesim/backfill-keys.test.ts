// 同义键回填：解析模型回复、按可见范围分批（不调模型）
import { describe, expect, it } from 'vitest'
import type { ModelClient } from '../p0/run.js'
import { backfill, parseKeys } from './backfill-keys.js'

describe('同义键回填', () => {
  it('解析：容忍代码块；只留请求里的编号；泛词去掉', () => {
    const text = '```json\n{"m_1": ["血型", "事情", "什么血"], "m_x": ["车"], "m_2": []}\n```'
    expect(parseKeys(text, new Set(['m_1', 'm_2']))).toEqual({ m_1: ['血型', '什么血'] })
    expect(parseKeys('不是 JSON', new Set(['m_1']))).toEqual({})
  })

  it('不同人看得到的记忆不放进同一批', async () => {
    const seen: string[] = []
    const model: ModelClient = {
      async complete(req) {
        const c = (req as { messages: Array<{ content: string }> }).messages[0]!.content
        seen.push(c)
        return { content: [{ type: 'text', text: '{}' }], usage: {} } as never
      },
    }
    const r = await backfill(model, [
      { id: 'm_1', content: '老大是AB型血。', visibility: 'person:p_owner' },
      { id: 'm_2', content: '小雨在考研。', visibility: 'person:p_sister' },
    ])
    expect(r.calls).toBe(2)
    expect(seen.every((c) => !(c.includes('m_1') && c.includes('m_2')))).toBe(true)
  })
})
