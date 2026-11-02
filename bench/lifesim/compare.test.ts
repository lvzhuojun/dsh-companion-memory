// 配对比较与成本尺子，不调模型
import { describe, expect, it } from 'vitest'
import { compareTable, costCurve, gate, pair, worldOf, type Row } from './compare.js'

const R = (id: string, ok: boolean, category: Row['category'] = 'stable'): Row => ({ id, ok, category })

describe('配对检验', () => {
  it('只在两边都有的题上配对；b = 基准对它错，c = 基准错它对', () => {
    const base = [R('a', true), R('b', true), R('c', false), R('d', false), R('only-base', true)]
    const other = [R('a', true), R('b', false), R('c', true), R('d', true), R('only-other', false)]
    expect(pair(base, other)).toMatchObject({ b: 1, c: 2, n: 4 })
  })

  it('p 值和精确二项一致：12 : 1 → 0.003，10 : 1 → 0.012', () => {
    const mk = (b: number, c: number) => {
      const base: Row[] = [], other: Row[] = []
      for (let i = 0; i < b; i++) { base.push(R(`b${i}`, true)); other.push(R(`b${i}`, false)) }
      for (let i = 0; i < c; i++) { base.push(R(`c${i}`, false)); other.push(R(`c${i}`, true)) }
      return pair(base, other).p
    }
    expect(mk(1, 12)).toBeCloseTo(0.0034, 3)
    expect(mk(1, 10)).toBeCloseTo(0.0117, 3)
  })

  it('守门（11-01 修订）：某类多错 2 题以上就不过；只差 1 题算波动；合计少于基准 − 1 也不过', () => {
    const base = [R('p1', true, 'cross_privacy'), R('p2', false, 'cross_privacy'), R('f1', true, 'forget'), R('f2', true, 'forget'), R('n1', true, 'never')]
    expect(gate(base, [R('p1', true, 'cross_privacy'), R('p2', true, 'cross_privacy'), R('f1', true, 'forget'), R('f2', true, 'forget'), R('n1', true, 'never')]).ok).toBe(true)
    // 遗忘一题变错：差 1 题，算波动；合计 −1 也允许
    expect(gate(base, [R('p1', true, 'cross_privacy'), R('p2', false, 'cross_privacy'), R('f1', false, 'forget'), R('f2', true, 'forget'), R('n1', true, 'never')]).ok).toBe(true)
    // 遗忘两题都变错：该类 b − c = 2 → 不过
    const g = gate(base, [R('p1', true, 'cross_privacy'), R('p2', false, 'cross_privacy'), R('f1', false, 'forget'), R('f2', false, 'forget'), R('n1', true, 'never')])
    expect(g.ok).toBe(false)
    expect(g.detail).toContain('遗忘')
    // 每类只差 1 题、但两类各差 1：合计 −2 → 不过
    expect(gate(base, [R('p1', false, 'cross_privacy'), R('p2', false, 'cross_privacy'), R('f1', false, 'forget'), R('f2', true, 'forget'), R('n1', true, 'never')]).ok).toBe(false)
  })

  it('表格：报告写法“它对基准错 : 它错基准对”', () => {
    const t = compareTable([
      { name: 'old', worlds: ['v2L-s4'], rows: [R('x', false), R('y', true)], ingest: 0, answer: 0 },
      { name: 'new', worlds: ['v2L-s4'], rows: [R('x', true), R('y', true)], ingest: 0, answer: 0 },
    ], 'old')
    expect(t).toContain('| new | v2L-s4 | 2（配对 2） | 100%')
    expect(t).toContain('| 1 : 0 |')
  })

  it('文件名 → 世界版本', () => {
    expect(worldOf('x/lifesim-v2L-s4-2026.json')).toEqual({ v: 2, volume: 'L', full: false })
    expect(worldOf('lifesim-full-v1S-s1-2026.json')).toEqual({ v: 1, volume: 'S', full: true })
    expect(worldOf('x/lifesim-v3L-s11-2026.json')).toEqual({ v: 3, volume: 'L', full: false })
    expect(worldOf('lifesim-s1-2026.json')).toEqual({ v: 1, volume: 'S', full: false })
  })
})

describe('成本尺子', () => {
  it('按天的增量 ÷ 当天句数；后期 ≤ 前期 × 1.2 算平', () => {
    const days = Array.from({ length: 100 }, (_, i) => ({ day: i + 1, answer: (i + 1) * 0.01 }))
    const turns = Array.from({ length: 100 }, () => 10)
    const c = costCurve(days, turns)
    expect(c.early).toBeCloseTo(0.001, 6)
    expect(c.flat).toBe(true)
    const rising = days.map((d) => ({ day: d.day, answer: d.day * d.day * 0.0001 }))
    expect(costCurve(rising, turns).flat).toBe(false)
  })
})
