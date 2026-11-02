// 开关 J 的门控校准。不调模型、不花钱。
//   tsx bench/lifesim/calibrate.ts --snap <快照目录> --seed 4 [--world-v 2] [--volume L]
//   tsx bench/lifesim/calibrate.ts --snap <快照目录> --seed 5 --check cue=1.2,soft=2,hi=3.1,delta=0.6   （核对：只报注入率）
// 做法：世界里每个人每天说的每句话，对“那天为止最近的一份快照”的记忆库跑一遍打分（preRecall dryRun、无门控），
//   记下 s1（最高分）、s2（第二）、线索强弱；再按分位数定门槛：
//     hi    = 无线索句子 s1 的 85% 分位（无线索时约 15% 的句子会注入）
//     cue   = 强线索句子 s1 的 20% 分位（强线索时约 80% 会注入）
//     soft  = (cue + hi) / 2
//     delta = 无线索句子 s1 − s2 的中位数
//   另外报考题本身（“我……什么来着”）的注入率与“注入了答案”的比例，作为门控好坏的直接参照。
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hardCue, MemoryStore, OWNER_ID, type GateThresholds } from '@dsh-companion/memory'
import { snapDir } from './run.js'
import { buildWorld, worldVersion } from './world.js'

export interface Sample { day: number; who: string; text: string; cue: 'strong' | 'soft' | 'none'; s1: number; s2: number; probe?: { id: string; hit: boolean } }

export const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))
  return s[i]!
}

export function fitGate(samples: Sample[]): GateThresholds {
  const none = samples.filter((s) => s.cue === 'none' && s.s1 > 0)
  const strong = samples.filter((s) => s.cue === 'strong' && s.s1 > 0)
  const hi = quantile(none.map((s) => s.s1), 0.85)
  const cue = quantile(strong.map((s) => s.s1), 0.2)
  const r = (x: number) => Math.round(x * 100) / 100
  return { cue: r(cue), soft: r((cue + hi) / 2), hi: r(hi), delta: r(quantile(none.map((s) => s.s1 - s.s2), 0.5)) }
}

export function passes(s: Pick<Sample, 'cue' | 's1' | 's2'>, g: GateThresholds): boolean {
  return (s.cue === 'strong' && s.s1 >= g.cue) || (s.cue === 'soft' && s.s1 >= g.soft) || (s.s1 >= g.hi && s.s1 - s.s2 >= g.delta)
}

if (process.argv[1] && /calibrate\.(ts|mjs|js)$/.test(process.argv[1])) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
  const snap = arg('--snap')
  const seed = Number(arg('--seed') ?? '4')
  if (!snap) { console.error('要给 --snap <快照目录>'); process.exit(2) }
  const w = buildWorld(seed, { v: worldVersion(arg('--world-v'), 2), volume: (arg('--volume') ?? 'L') === 'L' ? 'L' : 'S' })
  const names = w.people.map((p) => p.name)
  const snapDays = w.days.map((d) => d.day).filter((d) => existsSync(join(snapDir(snap, d), 'memory.db')))
  if (!snapDays.length) { console.error('快照目录里没有 day-NNN'); process.exit(2) }
  const samples: Sample[] = []
  const tmp = mkdtempSync(join(tmpdir(), 'calibrate-'))
  try {
    let open: { day: number; store: MemoryStore } | undefined
    const storeFor = (day: number) => {
      // 那天为止最近的一份快照（第一份之前的日子用第一份——偏乐观，但前几天句子少）
      const d = [...snapDays].reverse().find((x) => x <= day) ?? snapDays[0]!
      if (open?.day === d) return open.store
      open?.store.close()
      const dst = join(tmp, `d${d}`)
      cpSync(snapDir(snap, d), dst, { recursive: true })
      open = { day: d, store: MemoryStore.open(join(dst, 'memory.db'), { ownerName: '老大' }) }
      return open.store
    }
    for (const day of w.days) {
      const store = storeFor(day.day)
      const now = new Date(`${day.date}T21:00:00+08:00`)
      for (const s of day.sessions) for (const l of s.lines) {
        if (l.who === 'me') continue
        const viewer = { person: s.person, channel: 'private' }
        const cue = hardCue(l.text, names)
        const r = store.preRecall(l.text, viewer, now, { cue, dryRun: true, noGate: true })
        samples.push({ day: day.day, who: s.person, text: l.text, cue, s1: r.s1, s2: r.s2 })
      }
      // 考题（第二天早上问）：注入了没有、注入的里面有没有答案
      for (const p of w.probes.filter((x) => x.day === day.day)) {
        const viewer = { person: p.asker, channel: 'private' }
        const cue = hardCue(p.ask, names)
        const r = store.preRecall(p.ask, viewer, new Date(now.getTime() + 12 * 3600000), { cue, dryRun: true, noGate: true })
        const words = (p.keywords ?? []).flat()
        const hit = words.length > 0 && r.items.some((it) => words.some((k) => it.seen.text.includes(k)))
        samples.push({ day: day.day, who: p.asker, text: p.ask, cue, s1: r.s1, s2: r.s2, probe: { id: p.id, hit } })
      }
    }
    open?.store.close()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  const chat = samples.filter((s) => !s.probe)
  const probes = samples.filter((s) => s.probe)
  const checkArg = arg('--check')
  const g: GateThresholds = checkArg
    ? Object.fromEntries(checkArg.split(',').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)])) as unknown as GateThresholds
    : fitGate(chat)
  const rate = (xs: Sample[]) => xs.length ? `${Math.round((xs.filter((s) => passes(s, g)).length / xs.length) * 100)}%（${xs.filter((s) => passes(s, g)).length}/${xs.length}）` : '—'
  const by = (c: Sample['cue']) => chat.filter((s) => s.cue === c)
  console.log(`== 门控校准 · 种子 ${seed} · 快照 ${snapDays.length} 份 · 聊天句子 ${chat.length} · 考题 ${probes.length} ==`)
  console.log(`${checkArg ? '核对' : '拟合'}的门槛：cue ${g.cue} · soft ${g.soft} · hi ${g.hi} · delta ${g.delta}`)
  console.log(`聊天句子注入率：总 ${rate(chat)} · 强线索 ${rate(by('strong'))} · 弱线索 ${rate(by('soft'))} · 无线索 ${rate(by('none'))}`)
  const pr = probes.filter((s) => passes(s, g))
  console.log(`考题：注入 ${rate(probes)}；注入的里面带着答案 ${pr.filter((s) => s.probe!.hit).length}/${pr.length}；不门控时带着答案 ${probes.filter((s) => s.probe!.hit).length}/${probes.length}`)
  console.log(`分布：无线索 s1 中位 ${quantile(by('none').map((s) => s.s1), 0.5).toFixed(2)} · 强线索 s1 中位 ${quantile(by('strong').map((s) => s.s1), 0.5).toFixed(2)} · 说话人 ${[...new Set(samples.map((s) => s.who))].join('/')}（主人 = ${OWNER_ID}）`)
}
