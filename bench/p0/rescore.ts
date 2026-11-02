// 用当前的判分规则重判一份已保存的逐题记录（不调模型）：npm run bench:p0:rescore -- <结果 json>
// 判分规则改进后，用它在旧数据上对比；只打印 是/否 与题号，不打印回复。加 --show 打印仍需人工看的回复。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreOne, summarize } from './score.js'
import type { Dataset, Transcript } from './types.js'

const file = process.argv[2]
if (!file) {
  console.error('用法：npm run bench:p0:rescore -- <结果 json> [--show]')
  process.exit(64)
}
const ds = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cases.json'), 'utf8')) as Dataset
const saved = JSON.parse(readFileSync(file, 'utf8')) as { transcripts: Transcript[] }
const byId = new Map(ds.cases.map((c) => [c.id, c]))
const pairs = saved.transcripts.filter((t) => byId.has(t.caseId)).map((t) => ({ t, s: scoreOne(byId.get(t.caseId)!, t) }))
const summary = summarize(ds.cases, pairs.map((p) => p.s))
console.log(JSON.stringify(summary, null, 2))
for (const { t, s } of pairs) {
  if (!s.review && s.answerOk && !s.doubtWithoutBasis && !s.overpromise && !s.hedged && !s.falseClaim) continue
  const flags = [s.review && '需人工看', s.doubtWithoutBasis && '无据质疑', s.overpromise && '空口答应', s.hedged && '保留可能', s.falseClaim && '假称记下'].filter(Boolean).join('、')
  console.log(`${s.caseId} #${s.run} 回答 ${s.answerOk ? '✓' : '✗'}${flags ? '（' + flags + '）' : ''}${process.argv.includes('--show') ? '  ' + t.reply + (t.followUp ? ' ⇒ ' + t.followUp.reply : '') : ''}`)
}
