// 100 天模拟器 · 配对比较与成本尺子。不调模型。
//   tsx bench/lifesim/compare.ts [--base <系统>] [--no-rescore] <lifesim-*.json>...   配对检验：同世界同题号（默认先用当前判分重判）
//   tsx bench/lifesim/compare.ts --list <lifesim-*.json>...                 每个文件里有哪些系统、几题对
//   tsx bench/lifesim/compare.ts --cost-curve <lifesim-full-*.json>...      完整档：第 N 天每轮花费，判“跑久了会不会变贵”
// 口径：
//   - 题号加上世界前缀（v2L-s4:L4-001），多个世界的题合在一起比；同一系统同一世界出现多次时取最后给的文件（打印提醒）
//   - 报告写法“它对基准错 : 它错基准对”（好的在前）；内部 b = 基准对它错、c = 基准错它对；p = McNemar 精确双侧（bench/membench/report.ts），p < 0.05 才说有差别
//   - 区间 = 对题目 bootstrap 2000 次（固定种子）的 2.5% / 97.5% 分位
//   - 守门：拒伪、没提过、跨人隐私、遗忘、结束不再提——每类 b − c ≤ 1（11-01 修订：单次运行下一道题时对时错不该一票否决），且五类合计答对数 ≥ 基准 − 1，否则“不过”
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { bootstrap, mcnemar } from '../membench/report.js'
import { judgeProbe } from './run.js'
import { buildWorld, worldVersion, type Probe } from './world.js'

export interface Row { id: string; ok: boolean; category: Probe['category']; stale?: boolean }
export interface SysRows { name: string; rows: Row[]; worlds: string[]; ingest: number; answer: number }

export const GATE: Probe['category'][] = ['false_premise', 'never', 'cross_privacy', 'forget', 'promise_closed']
export const CAT_NAME: Record<string, string> = { stable: '稳定事实', latest: '最新版本', history: '以前的版本', date: '日期', chain: '长链路', promise_due: '到时候问', promise_closed: '结束不再提', cross_privacy: '跨人隐私', forget: '遗忘', false_premise: '拒伪', never: '没提过',
  // v3；没有这类题的世界里不出行（compareTable 跳过空类别）
  misattrib: '张冠李戴', misattrib_ctrl: '张冠李戴·对照', paraphrase: '换个问法', source: '来源', implicit: '隐式偏好', inject: '不被教坏', crisis: '危机', goodbye: '告别' }
const CATS = Object.keys(CAT_NAME) as Probe['category'][]

/** 文件名 → 世界版本与量级（和 rescore.ts 一致；旧名 lifesim-s1-… 视为 v1·S） */
export function worldOf(file: string): { v: 1 | 2 | 3 | 4; volume: 'S' | 'L'; full: boolean } {
  const m = /lifesim-(full-)?v(\d)([SL])-/.exec(basename(file))
  return m ? { v: worldVersion(m[2]), volume: m[3] === 'L' ? 'L' : 'S', full: !!m[1] } : { v: 1, volume: 'S', full: /lifesim-full-/.test(file) }
}

interface LifeJson { seed: number; mode?: string; results: Array<{ system: string; probes: Array<{ id: string; ok: boolean; category: Probe['category']; stale?: boolean; reply?: string }>; days: Array<{ day: number; ingest: number; answer: number }> }> }

/** 用当前判分规则把保存的回复重判一遍（判分修过以后，新旧结果才可比） */
function rejudge(j: LifeJson, v: 1 | 2 | 3 | 4, volume: 'S' | 'L') {
  const w = buildWorld(j.seed, { v, volume })
  const byId = new Map(w.probes.map((p) => [p.id, p]))
  for (const r of j.results) for (const p of r.probes) {
    const probe = byId.get(p.id)
    if (!probe || p.reply === undefined) continue
    const x = judgeProbe(probe, p.reply)
    p.ok = x.ok
    if (x.stale !== undefined) p.stale = x.stale
    else delete p.stale
  }
}

/** 读结果文件，按系统合并各世界的题（同系统同世界取最后一个文件）；rescore = 先用当前判分重判 */
export function loadSystems(files: string[], warn: (s: string) => void = () => {}, o: { rescore?: boolean } = {}): SysRows[] {
  const by = new Map<string, Map<string, SysRows & { file: string }>>()
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, 'utf8')) as LifeJson
    const w = worldOf(f)
    if (o.rescore) rejudge(j, w.v, w.volume)
    const wk = `v${w.v}${w.volume}-s${j.seed}${j.mode === 'full' ? '-full' : ''}`
    for (const r of j.results) {
      const per = by.get(r.system) ?? new Map()
      if (per.has(wk)) warn(`提醒：${r.system} 在 ${wk} 上有多个结果，用 ${basename(f)}（替换 ${basename(per.get(wk)!.file)}）`)
      const last = r.days[r.days.length - 1]
      per.set(wk, { name: r.system, file: f, worlds: [wk], ingest: last?.ingest ?? 0, answer: last?.answer ?? 0, rows: r.probes.map((p) => ({ id: `${wk}:${p.id}`, ok: p.ok, category: p.category, ...(p.stale !== undefined ? { stale: p.stale } : {}) })) })
      by.set(r.system, per)
    }
  }
  return [...by.values()].map((per) => {
    const xs = [...per.values()].sort((a, b) => a.worlds[0]!.localeCompare(b.worlds[0]!))
    return { name: xs[0]!.name, worlds: xs.map((x) => x.worlds[0]!), rows: xs.flatMap((x) => x.rows), ingest: xs.reduce((n, x) => n + x.ingest, 0), answer: xs.reduce((n, x) => n + x.answer, 0) }
  })
}

export interface Pair { b: number; c: number; p: number; n: number }
/** 只在两边都有的题上配对 */
export function pair(base: Row[], other: Row[], cat?: Probe['category']): Pair {
  const mine = new Map(base.filter((r) => !cat || r.category === cat).map((r) => [r.id, r.ok]))
  let b = 0, c = 0, n = 0
  for (const r of other) {
    if (cat && r.category !== cat) continue
    const m = mine.get(r.id)
    if (m === undefined) continue
    n++
    if (m && !r.ok) b++
    if (!m && r.ok) c++
  }
  return { b, c, n, p: mcnemar(b, c) }
}

/** 守门：每类 b − c ≤ 1（11-01 预注册修订），且五类合计答对 ≥ 基准 − 1（只算两边都有的题） */
export function gate(base: Row[], other: Row[]): { ok: boolean; detail: string } {
  const common = new Set(other.map((r) => r.id))
  const gb = base.filter((r) => GATE.includes(r.category) && common.has(r.id))
  const ids = new Set(gb.map((r) => r.id))
  const go = other.filter((r) => ids.has(r.id))
  const per = GATE.map((cat) => ({ cat, ...pair(base, other, cat) })).filter((x) => x.n > 0)
  const worse = per.filter((x) => x.b - x.c > 1)
  const sumBase = gb.filter((r) => r.ok).length
  const sumNew = go.filter((r) => r.ok).length
  const ok = worse.length === 0 && sumNew >= sumBase - 1
  return { ok, detail: `${sumNew}/${go.length} vs ${sumBase}/${gb.length}${worse.length ? `；变差：${worse.map((x) => `${CAT_NAME[x.cat]} ${x.c} : ${x.b}`).join('、')}` : ''}` }
}

const pct = (x: number) => (Number.isNaN(x) ? '—' : `${Math.round(x * 100)}%`)
const acc = (rs: Row[]) => rs.length ? rs.filter((r) => r.ok).length / rs.length : NaN

export function compareTable(systems: SysRows[], baseName?: string): string {
  const base = systems.find((s) => s.name === baseName) ?? systems[0]!
  const out: string[] = []
  out.push(`基准：**${base.name}**（世界 ${base.worlds.join('、')}）`, '')
  out.push('| 系统 | 世界 | n | 总体 [95% 区间] | 和基准比（它对基准错 : 它错基准对） | p | 守门（§9.4） | 拿旧当新 | 建记忆¥ | 答题¥ |', '|---|---|---|---|---|---|---|---|---|---|')
  for (const s of systems) {
    const [lo, hi] = bootstrap(s.rows.map((r) => r.ok))
    const latest = s.rows.filter((r) => r.category === 'latest')
    const stale = latest.length ? pct(latest.filter((r) => r.stale).length / latest.length) : '—'
    if (s === base) {
      out.push(`| ${s.name} | ${s.worlds.join(' ')} | ${s.rows.length} | ${pct(acc(s.rows))} [${pct(lo)}–${pct(hi)}] | — | — | — | ${stale} | ${s.ingest.toFixed(2)} | ${s.answer.toFixed(2)} |`)
      continue
    }
    const pr = pair(base.rows, s.rows)
    const g = gate(base.rows, s.rows)
    out.push(`| ${s.name} | ${s.worlds.join(' ')} | ${s.rows.length}（配对 ${pr.n}） | ${pct(acc(s.rows))} [${pct(lo)}–${pct(hi)}] | ${pr.c} : ${pr.b} | ${pr.p.toFixed(3)} | ${g.ok ? '过' : '**不过**'}（${g.detail}） | ${stale} | ${s.ingest.toFixed(2)} | ${s.answer.toFixed(2)} |`)
  }
  // 分类别的 b : c
  const others = systems.filter((s) => s !== base)
  if (others.length) {
    out.push('', `分类别（各格 = 答对率；括号里是和 ${base.name} 比的“它对基准错 : 它错基准对”）：`, '', `| 类别 | ${base.name} | ${others.map((s) => s.name).join(' | ')} |`, `|${'---|'.repeat(2 + others.length)}`)
    for (const c of CATS) {
      const rb = base.rows.filter((r) => r.category === c)
      if (!rb.length && !others.some((s) => s.rows.some((r) => r.category === c))) continue
      out.push(`| ${CAT_NAME[c]}${GATE.includes(c) ? '（守门）' : ''} | ${pct(acc(rb))} | ${others.map((s) => { const pr = pair(base.rows, s.rows, c); return `${pct(acc(s.rows.filter((r) => r.category === c)))}（${pr.c} : ${pr.b}）` }).join(' | ')} |`)
    }
  }
  out.push('', '前一个数 = 它对、基准错的题；后一个数 = 它错、基准对的题；p 为 McNemar 精确双侧，p < 0.05 才说有差别。')
  return out.join('\n')
}

// ---------- 成本尺子：完整档每天的“每句花费” ----------
/** 每天她要回几次 = 真人说的句数 + 当天的考题（完整档里考题也在会话里答，花费算在同一天） */
export function turnsPerDay(seed: number, v: 1 | 2 | 3 | 4, volume: 'S' | 'L'): number[] {
  const w = buildWorld(seed, { v, volume })
  return w.days.map((d, i) => d.sessions.reduce((n, s) => n + s.lines.filter((l) => l.who !== 'me').length, 0) + w.probes.filter((p) => p.day === i + 1).length)
}

export function costCurve(days: Array<{ day: number; answer: number }>, turns: number[]): { rows: Array<{ day: number; perTurn: number }>; early: number; late: number; flat: boolean } {
  const rows: Array<{ day: number; perTurn: number }> = []
  for (let i = 0; i < days.length; i++) {
    const d = days[i]!
    const prev = i > 0 ? days[i - 1]!.answer : 0
    const t = turns[d.day - 1] ?? 0
    if (t > 0) rows.push({ day: d.day, perTurn: (d.answer - prev) / t })
  }
  const mean = (lo: number, hi: number) => { const xs = rows.filter((r) => r.day >= lo && r.day <= hi).map((r) => r.perTurn); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN }
  const early = mean(10, 20)
  const late = mean(90, 100)
  return { rows, early, late, flat: late <= early * 1.2 }
}

// ---------- 命令行 ----------
if (process.argv[1] && /compare\.(ts|mjs|js)$/.test(process.argv[1])) {
  const args = process.argv.slice(2)
  const flag = (k: string) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v }
  const has = (k: string) => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true }
  const baseName = flag('--base')
  const list = has('--list')
  const curve = has('--cost-curve')
  const rescore = !has('--no-rescore')
  const files = args
  if (!files.length) { console.error('用法见文件头'); process.exit(2) }
  if (list) {
    for (const f of files) {
      const j = JSON.parse(readFileSync(f, 'utf8')) as LifeJson
      const w = worldOf(f)
      console.log(`${basename(f)}  v${w.v}${w.volume} s${j.seed}${j.mode === 'full' ? ' 完整档' : ''}  ${j.results.map((r) => `${r.system} ${r.probes.filter((p) => p.ok).length}/${r.probes.length}`).join(' · ')}`)
    }
  } else if (curve) {
    for (const f of files) {
      const j = JSON.parse(readFileSync(f, 'utf8')) as LifeJson
      const w = worldOf(f)
      const turns = turnsPerDay(j.seed, w.v, w.volume)
      for (const r of j.results) {
        const c = costCurve(r.days, turns)
        console.log(`\n### ${basename(f)} · ${r.system}`)
        console.log('| 天 | ' + c.rows.filter((x) => x.day % 10 === 0 || x.day === 1).map((x) => x.day).join(' | ') + ' |')
        console.log('|---|' + c.rows.filter((x) => x.day % 10 === 0 || x.day === 1).map(() => '---|').join(''))
        console.log('| 每句 ¥ | ' + c.rows.filter((x) => x.day % 10 === 0 || x.day === 1).map((x) => x.perTurn.toFixed(4)).join(' | ') + ' |')
        console.log(`\n第 10–20 天平均每句 ¥${c.early.toFixed(4)}，第 90–100 天 ¥${c.late.toFixed(4)}（×${(c.late / c.early).toFixed(2)}）→ ${c.flat ? '平（≤ ×1.2）' : '**上翘**（> ×1.2）'}`)
      }
    }
  } else {
    console.log(compareTable(loadSystems(files, (s) => console.error(s), { rescore }), baseName))
    console.log(rescore ? '（已用当前判分规则重判保存的回复；--no-rescore 用文件里存的对错）' : '（用的是文件里存的对错）')
  }
}
