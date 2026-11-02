// 微基准 7-3 的出题与判分（不调模型）
import { describe, expect, it } from 'vitest'
import { buildPrefix, buildQuestions, judgeMicro } from './prefix-distractor.js'

describe('微基准 7-3', () => {
  const qs = buildQuestions(3)

  it('40 题，答案行都在前缀里；干扰项数量按档位放；大小接近目标', () => {
    expect(qs).toHaveLength(40)
    expect(new Set(qs.map((q) => q.id)).size).toBe(40)
    for (const nd of [0, 1, 4]) {
      const p = buildPrefix(qs, 15000, nd, 3)
      for (const q of qs) expect(p).toContain(q.line)
      const shown = qs.flatMap((q) => q.distractors.slice(0, nd)).filter((d) => p.includes(d.line)).length
      expect(shown).toBe(qs.reduce((n, q) => n + Math.min(nd, q.distractors.length), 0))
      expect(p.length).toBeGreaterThanOrEqual(15000)
      expect(p.length).toBeLessThan(15200)
    }
  })

  it('干扰项的值和答案不同；同种子可复现', () => {
    for (const q of qs) for (const d of q.distractors) expect(d.value).not.toBe(q.answer)
    expect(buildPrefix(buildQuestions(3), 8000, 1, 3)).toBe(buildPrefix(qs, 8000, 1, 3))
  })

  it('判分：答案命中算对；说成干扰项的值算“被带偏”；日期认“号”', () => {
    const q = qs.find((x) => x.kind === 'stable')!
    expect(judgeMicro(q, `是${q.answer}呀`, 4)).toEqual({ ok: true, trapped: false })
    expect(judgeMicro(q, `是${q.distractors[0]!.value}吧`, 4)).toEqual({ ok: false, trapped: true })
    expect(judgeMicro(q, `是${q.distractors[0]!.value}吧`, 0)).toEqual({ ok: false, trapped: false })
    const d = qs.find((x) => x.kind === 'date')!
    expect(judgeMicro(d, `${d.answer.replace('日', '号')}那天`, 0).ok).toBe(true)
  })
})
