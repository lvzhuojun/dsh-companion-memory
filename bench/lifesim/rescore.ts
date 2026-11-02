// 100 天模拟 · 重判（不调模型）：判分或标准答案改进后，用保存的回答重新判，让新旧结果在同一个口径上比。
//   tsx bench/lifesim/rescore.ts <lifesim-*.json>...
// 世界版本和量级从文件名读（lifesim-v2L-s3-… / 旧的 lifesim-s1-… = v1·S；完整档 lifesim-full-v1S-s1-…）。
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { judgeProbe, lifeTable, type LifeResult } from './run.js'
import { buildWorld, worldVersion } from './world.js'

export function worldOf(file: string): { v: 1 | 2 | 3 | 4; volume: 'S' | 'L' } {
  const m = /lifesim-(?:full-)?v(\d)([SL])-/.exec(basename(file))
  return m ? { v: worldVersion(m[1]), volume: m[2] as 'S' | 'L' } : { v: 1, volume: 'S' }
}

export function rescore(file: string): LifeResult[] {
  const j = JSON.parse(readFileSync(file, 'utf8')) as { seed: number; results: LifeResult[] }
  const w = buildWorld(j.seed, worldOf(file))
  const byId = new Map(w.probes.map((p) => [p.id, p]))
  return j.results.map((r) => ({
    ...r,
    probes: r.probes.map((p) => {
      const def = byId.get(p.id)
      if (!def) return p
      const k = judgeProbe(def, p.reply)
      return { ...p, ok: k.ok, ...(k.stale !== undefined ? { stale: k.stale } : {}) }
    }),
  }))
}

if (process.argv[1] && /rescore\.(ts|mjs|js)$/.test(process.argv[1])) {
  const groups = new Map<string, LifeResult[]>()
  for (const f of process.argv.slice(2)) {
    const w = worldOf(f)
    const seed = (JSON.parse(readFileSync(f, 'utf8')) as { seed: number }).seed
    const key = `v${w.v}${w.volume} · 种子 ${seed}`
    groups.set(key, [...(groups.get(key) ?? []), ...rescore(f)])
  }
  for (const [k, rs] of groups) console.log(`\n### ${k}\n\n${lifeTable(rs)}`)
}
