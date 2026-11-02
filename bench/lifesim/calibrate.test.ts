// 门控校准的分位数与判定，不调模型
import { describe, expect, it } from 'vitest'
import { fitGate, passes, quantile, type Sample } from './calibrate.js'

const S = (cue: Sample['cue'], s1: number, s2 = 0): Sample => ({ day: 1, who: 'p', text: '', cue, s1, s2 })

describe('门控校准', () => {
  it('分位数', () => {
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3)
    expect(quantile([], 0.5)).toBeNaN()
  })

  it('拟合：无线索约 15% 过、强线索约 80% 过', () => {
    const none = Array.from({ length: 100 }, (_, i) => S('none', i / 10, i / 20))
    const strong = Array.from({ length: 100 }, (_, i) => S('strong', 2 + i / 10))
    const g = fitGate([...none, ...strong])
    const rate = (xs: Sample[]) => xs.filter((s) => passes(s, g)).length / xs.length
    expect(rate(strong)).toBeGreaterThanOrEqual(0.79)
    expect(rate(none)).toBeLessThanOrEqual(0.16)
    expect(g.soft).toBeCloseTo((g.cue + g.hi) / 2, 1)
  })
})
