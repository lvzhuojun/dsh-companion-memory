// 记忆基准运行器：每个系统 → 依次读完所有对话（建记忆）→ 回答同一批题 → 用题集同一套判分（bench/p0/score.ts）
import { buildSynth } from '../synth/build.js'
import { scoreOne, summarize, type CaseScore, type Summary } from '../p0/score.js'
import type { Case, Transcript as P0Transcript } from '../p0/types.js'
import { costOf, type MemorySystem, type Usage } from './systems.js'
import type { ModelClient } from '../p0/run.js'
import { judge, refused } from './judge.js'
import type { LocomoSet } from './locomo.js'
import type { Transcript } from './transcript.js'

export interface SystemResult {
  system: string
  note: string
  usage: { ingest: Usage; answer: Usage }
  cost: { ingest: number; answer: number }
  scores: CaseScore[]
  summary: Summary
  /** 全部题的答对率 */
  accuracy: number
  transcripts: P0Transcript[]
}

/** 题目：合成赛道的判分口径（和题集一致）；按类别固定抽样（每类最多 perCat 道，按编号取前面的，可复现） */
export function pickCases(t: Transcript, o: { only?: string[]; perCat?: number } = {}): Case[] {
  const byId = new Map(buildSynth().cases.map((c) => [c.id, c]))
  const cases = t.questions.map((q) => byId.get(q.id)!).filter((c) => !o.only?.length || o.only.some((p) => c.id.startsWith(p)))
  if (!o.perCat) return cases
  const n = new Map<string, number>()
  return cases.filter((c) => {
    const k = (n.get(c.category) ?? 0) + 1
    n.set(c.category, k)
    return k <= o.perCat!
  })
}

export async function runSystem(sys: MemorySystem, t: Transcript, cases: Case[], log: (s: string) => void = () => {}): Promise<SystemResult> {
  const t0 = Date.now()
  try {
    for (const s of t.sessions) await sys.ingest(s)
    log(`  [${sys.id}] 建记忆完成：${t.sessions.length} 段对话，${Math.round((Date.now() - t0) / 1000)} 秒`)
    const transcripts: P0Transcript[] = []
    const scores: CaseScore[] = []
    for (const c of cases) {
      const a = await sys.answer(c.user).catch((e: unknown) => ({ reply: '', toolCalls: [], error: e instanceof Error ? e.message.slice(0, 160) : String(e) }))
      const tr: P0Transcript = { caseId: c.id, run: 1, toolCalls: a.toolCalls, reply: a.reply, variant: sys.id, ...(a.error ? { error: a.error } : {}) }
      transcripts.push(tr)
      const sc = scoreOne(c, tr)
      scores.push(sc)
      log(`  [${sys.id}] ${c.id} ${sc.answerOk ? '✓' : '✗'}${tr.error ? ' 出错' : ''}`)
    }
    const accuracy = scores.filter((s) => s.answerOk).length / Math.max(1, scores.length)
    return {
      system: sys.id, note: sys.note, usage: sys.usage,
      cost: { ingest: ingestCostOf(sys), answer: costOf(sys.usage.answer) },
      scores, summary: summarize(cases, scores), accuracy, transcripts,
    }
  } finally {
    sys.close()
  }
}

// ---------- LoCoMo（公开基准）：LLM 评委打分，宽松 / 严格两种口径；对抗题单独判拒答 ----------

export interface LocomoResult {
  system: string
  note: string
  usage: { ingest: Usage; answer: Usage }
  cost: { ingest: number; answer: number }
  rows: Array<{ id: string; category: string; adversarial: boolean; reply: string; lenient?: boolean; strict?: boolean; refused?: boolean; error?: string }>
  /** 非对抗题：宽松 / 严格答对率；对抗题：拒答率 */
  lenient: number
  strict: number
  refusal: number
  byCategory: Record<string, { n: number; lenient: number; strict: number }>
}

export async function runLocomo(sys: MemorySystem, set: LocomoSet, judgeModel: ModelClient, log: (s: string) => void = () => {}): Promise<LocomoResult> {
  try {
    for (const s of set.transcript.sessions) await sys.ingest(s)
    log(`  [${sys.id}] 建记忆完成：${set.transcript.sessions.length} 段对话`)
    const rows: LocomoResult['rows'] = []
    for (const q of set.questions) {
      const a = await sys.answer(`${q.ask}\n（简短回答就好）`).catch((e: unknown) => ({ reply: '', toolCalls: [], error: e instanceof Error ? e.message.slice(0, 160) : String(e) }))
      const row: LocomoResult['rows'][number] = { id: q.id, category: q.category, adversarial: q.adversarial, reply: a.reply, ...(a.error ? { error: a.error } : {}) }
      if (q.adversarial) row.refused = refused(a.reply)
      else {
        row.lenient = await judge(judgeModel, 'lenient', { ask: q.ask, gold: q.gold, reply: a.reply })
        row.strict = await judge(judgeModel, 'strict', { ask: q.ask, gold: q.gold, reply: a.reply })
      }
      rows.push(row)
      log(`  [${sys.id}] ${q.id} ${q.adversarial ? (row.refused ? '拒答✓' : '拒答✗') : `${row.lenient ? '✓' : '✗'}${row.strict ? '✓' : '✗'}`}`)
    }
    const main = rows.filter((r) => !r.adversarial)
    const adv = rows.filter((r) => r.adversarial)
    const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : NaN)
    const byCategory: LocomoResult['byCategory'] = {}
    for (const cat of [...new Set(main.map((r) => r.category))]) {
      const rs = main.filter((r) => r.category === cat)
      byCategory[cat] = { n: rs.length, lenient: rate(rs.map((r) => !!r.lenient)), strict: rate(rs.map((r) => !!r.strict)) }
    }
    return {
      system: sys.id, note: sys.note, usage: sys.usage, cost: { ingest: ingestCostOf(sys), answer: costOf(sys.usage.answer) },
      rows, lenient: rate(main.map((r) => !!r.lenient)), strict: rate(main.map((r) => !!r.strict)), refusal: rate(adv.map((r) => !!r.refused)), byCategory,
    }
  } finally {
    sys.close()
  }
}

export function locomoTable(results: LocomoResult[]): string {
  const cats = ['single_hop', 'multi_hop', 'temporal', 'open_domain']
  const name: Record<string, string> = { single_hop: '单跳', multi_hop: '多跳', temporal: '时间', open_domain: '开放域' }
  const head = ['系统', '宽松 J', '严格', ...cats.map((c) => name[c] + '（宽/严）'), '对抗题拒答', '建记忆¥', '答题¥']
  const rows = results.map((r) => [r.system, pct(r.lenient), pct(r.strict),
    ...cats.map((c) => (r.byCategory[c] ? `${pct(r.byCategory[c]!.lenient)} / ${pct(r.byCategory[c]!.strict)}` : '—')),
    pct(r.refusal), r.cost.ingest.toFixed(3), r.cost.answer.toFixed(3)])
  return [head, ...rows].map((row) => '| ' + row.join(' | ') + ' |').join('\n').replace(/^(\|[^\n]*\n)/, (m) => m + '|' + head.map(() => '---').join('|') + '|\n')
}

const pct = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${Math.round(x * 100)}%`)

/** 对比表（只有数字，不含回复） */
export function table(results: SystemResult[]): string {
  const cats = ['fact_recall', 'fact_update', 'temporal', 'promise', 'emotion', 'false_premise', 'never_mentioned', 'privacy', 'forget']
  const name: Record<string, string> = { fact_recall: '事实', fact_update: '更新', temporal: '时间', promise: '承诺', emotion: '情绪', false_premise: '拒伪', never_mentioned: '没提过', privacy: '隐私', forget: '遗忘' }
  const present = cats.filter((c) => results.some((r) => r.summary.byCategory[c] !== undefined))
  const head = ['系统', '总体', ...present.map((c) => name[c]!), '拿旧当新', '建记忆¥', '答题¥', '答题调用']
  const rows = results.map((r) => [
    r.system, pct(r.accuracy), ...present.map((c) => pct(r.summary.byCategory[c])), pct(r.summary.staleRate),
    r.cost.ingest.toFixed(3), r.cost.answer.toFixed(3), String(r.usage.answer.calls),
  ])
  return [head, ...rows].map((row) => '| ' + row.join(' | ') + ' |').join('\n').replace(/^(\|[^\n]*\n)/, (m) => m + '|' + head.map(() => '---').join('|') + '|\n')
}

/** 建记忆花费：系统自己报了花费（mem0 这类内部调用数不到 token 的，可选）就用它，否则按 token 估算 */
function ingestCostOf(sys: MemorySystem): number {
  const own = (sys as { ingestCost?: number }).ingestCost
  return typeof own === 'number' ? own : costOf(sys.usage.ingest)
}
