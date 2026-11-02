// 记忆基准的汇总（不调模型）：把多次运行（可以来自不同机器）和 Claude 参照线的结果合成一张表，带 95% 区间和配对检验。
//   tsx bench/membench/report.ts <结果.json>... [--claude <答案.json> --size S]
// 统计口径：
//   - 区间：对题目做 bootstrap（2000 次，固定种子），报答对率的 2.5% / 97.5% 分位
//   - 配对检验：同一批题上“我们”对每个系统做 McNemar（精确二项），只看两边答案不同的题
import { readFileSync } from 'node:fs'
import { scoreOne } from '../p0/score.js'
import { pickCases } from './run.js'
import { buildTranscript, SIZES } from './transcript.js'

interface Row { id: string; ok: boolean; category: string }
interface Sys { name: string; rows: Row[]; ingest?: number; answer?: number }

export function bootstrap(oks: boolean[], n = 2000, seed = 42): [number, number] {
  if (oks.length === 0) return [NaN, NaN]
  let s = seed >>> 0
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const means: number[] = []
  for (let i = 0; i < n; i++) {
    let k = 0
    for (let j = 0; j < oks.length; j++) if (oks[Math.floor(rnd() * oks.length)]) k++
    means.push(k / oks.length)
  }
  means.sort((a, b) => a - b)
  return [means[Math.floor(n * 0.025)]!, means[Math.floor(n * 0.975)]!]
}

/** McNemar 精确检验（双侧）：b = 我们对、对方错；c = 我们错、对方对 */
export function mcnemar(b: number, c: number): number {
  const n = b + c
  if (n === 0) return 1
  const k = Math.min(b, c)
  let p = 0
  let comb = 1
  for (let i = 0; i <= k; i++) {
    if (i > 0) comb = (comb * (n - i + 1)) / i
    p += comb / 2 ** n
  }
  return Math.min(1, 2 * p)
}

const pct = (x: number) => (Number.isNaN(x) ? '—' : `${Math.round(x * 100)}%`)

export function render(systems: Sys[], title: string, ref = 'ours'): string {
  const cats = [...new Set(systems.flatMap((s) => s.rows.map((r) => r.category)))]
  const out: string[] = [`### ${title}`, '', `| 系统 | n | 答对率 [95% 区间] | ${cats.join(' | ')} | 建记忆¥ | 答题¥ | 和 ${ref} 比（McNemar p） |`, `|${'---|'.repeat(6 + cats.length)}`]
  const base = systems.find((s) => s.name === ref)
  for (const s of systems) {
    const oks = s.rows.map((r) => r.ok)
    const acc = oks.filter(Boolean).length / Math.max(1, oks.length)
    const [lo, hi] = bootstrap(oks)
    const byCat = cats.map((c) => {
      const rs = s.rows.filter((r) => r.category === c)
      return rs.length ? pct(rs.filter((r) => r.ok).length / rs.length) : '—'
    })
    let vs = '—'
    if (base && s !== base) {
      const mine = new Map(base.rows.map((r) => [r.id, r.ok]))
      let b = 0
      let c = 0
      for (const r of s.rows) {
        const m = mine.get(r.id)
        if (m === undefined) continue
        if (m && !r.ok) b++
        if (!m && r.ok) c++
      }
      vs = `${b} : ${c}，p=${mcnemar(b, c).toFixed(3)}`
    }
    out.push(`| ${s.name} | ${oks.length} | ${pct(acc)} [${pct(lo)}–${pct(hi)}] | ${byCat.join(' | ')} | ${s.ingest?.toFixed(2) ?? '—'} | ${s.answer?.toFixed(2) ?? '—'} | ${vs} |`)
  }
  out.push('', `McNemar 那一列是“${ref} 对、它错 : ${ref} 错、它对”的题数；p < 0.05 才说两者有差别。`)
  return out.join('\n')
}

// ---------- 命令行 ----------
if (process.argv[1] && /report\.(ts|mjs|js)$/.test(process.argv[1])) {
  const args = process.argv.slice(2)
  const files: string[] = []
  let claude: string | undefined
  let size: keyof typeof SIZES = 'S'
  let ref = 'ours'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--claude') claude = args[++i]
    else if (args[i] === '--size') size = args[++i] as keyof typeof SIZES
    else if (args[i] === '--ref') ref = args[++i]!
    else files.push(args[i]!)
  }
  const membench: Sys[] = []
  const locomo: Sys[] = []
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    if (j.results) {
      if (j.size !== size) continue
      for (const r of j.results) membench.push({ name: r.system, ingest: r.cost.ingest, answer: r.cost.answer, rows: r.scores.map((s: { caseId: string; answerOk: boolean; category: string }) => ({ id: s.caseId, ok: s.answerOk, category: s.category })) })
    } else if (j.perConv) {
      const by = new Map<string, Sys>()
      for (const pc of j.perConv) for (const r of pc.results) {
        const s: Sys = by.get(r.system) ?? { name: r.system, rows: [], ingest: 0, answer: 0 }
        s.ingest! += r.cost.ingest
        s.answer! += r.cost.answer
        for (const row of r.rows) if (!row.adversarial) s.rows.push({ id: row.id, ok: !!row.lenient, category: row.category })
        by.set(r.system, s)
      }
      locomo.push(...by.values())
    }
  }
  if (claude) {
    const ans = JSON.parse(readFileSync(claude, 'utf8')) as Record<string, string>
    const t = buildTranscript(undefined, SIZES[size])
    const cases = pickCases(t).filter((c) => ans[c.id] !== undefined)
    membench.push({ name: 'claude-full（参照）', rows: cases.map((c) => ({ id: c.id, ok: scoreOne(c, { caseId: c.id, run: 1, toolCalls: [], reply: ans[c.id]! }).answerOk, category: c.category })) })
  }
  if (membench.length) console.log(render(membench, `中文陪伴基准 dev · ${size} 版`, ref) + '\n')
  if (locomo.length) console.log(render(locomo, 'LoCoMo（非对抗题，宽松评委）', ref))
}
