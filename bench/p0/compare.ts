// 把几次题集结果用当前的判分重算，并排成一张表（只打印数字）：npx tsx bench/p0/compare.ts <结果 json>…
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSynth } from '../synth/build.js'
import { scoreOne, summarize, type Summary } from './score.js'
import type { Dataset, Transcript } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
const p0 = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')) as Dataset
const pct = (x: number) => (Number.isNaN(x) || x === null ? '—' : (x * 100).toFixed(0) + '%')
const rows: Array<[string, (s: Summary) => string]> = [
  ['伪记忆接受率', (s) => pct(s.falseMemoryAcceptance)], ['拒答正确率', (s) => pct(s.refusalCorrect)], ['日记回忆准确率', (s) => pct(s.diaryRecallAccuracy)],
  ['档案未被复述', (s) => pct(s.archiveNotRecited)], ['眼前上下文', (s) => pct(s.inContextAccuracy)], ['真事认下率', (s) => pct(s.truePremiseConfirmed)],
  ['做不到直说', (s) => pct(s.capabilityDeclined)], ['空口答应', (s) => pct(s.overpromiseRate)], ['无据质疑', (s) => pct(s.doubtWithoutBasisRate)],
  ['记下率', (s) => pct(s.recordRate)], ['假称已记下', (s) => pct(s.falseClaimRate)], ['没工具不假称', (s) => pct(s.noToolHonest)],
  ['隔会话回忆', (s) => pct(s.rememberThenRecall)], ['亲口说的记成事实', (s) => pct(s.toldKindOk)], ['来源记对', (s) => pct(s.sourceOk)], ['该翻时翻了', (s) => pct(s.recallWhenNeeded)],
  ['多余调用', (s) => pct(s.extraRecallRate)], ['平均调用次数', (s) => s.avgCallsWhenCalled.toFixed(2)],
]
const cols = process.argv.slice(2).map((f) => {
  const r = JSON.parse(readFileSync(f, 'utf8')) as { dataset: string; variant: string; real?: boolean; qq?: boolean; transcripts: Transcript[] }
  const ds = r.dataset.startsWith('synth') ? buildSynth() : p0
  const byId = new Map(ds.cases.map((c) => [c.id, c]))
  const ts = r.transcripts.filter((t) => byId.has(t.caseId))
  const s = summarize(ds.cases, ts.map((t) => scoreOne(byId.get(t.caseId)!, t)))
  return { head: `${r.variant}${r.real ? '·真实' : r.qq ? '·QQ' : ''}（${s.runs}轮）`, s }
})
console.log(['指标', ...cols.map((c) => c.head)].join(' | '))
for (const [name, f] of rows) console.log([name, ...cols.map((c) => f(c.s))].join(' | '))
const cats = [...new Set(cols.flatMap((c) => Object.keys(c.s.byCategory)))]
if (cols.some((c) => 'fact_recall' in c.s.byCategory)) {
  for (const cat of cats) console.log([`  ${cat}`, ...cols.map((c) => pct(c.s.byCategory[cat] ?? NaN))].join(' | '))
  console.log(['  拿旧版本当现在', ...cols.map((c) => pct(c.s.staleRate))].join(' | '))
}
