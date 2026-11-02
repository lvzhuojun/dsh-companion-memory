// 记忆基准命令行。用你自己的模型接口与 API key 跑。
//   tsx bench/membench/cli.ts --systems none,full,bm25,ours [--size S|L] [--only sr,su] [--per-cat 10]
// 环境变量同题集：BENCH_BASE_URL、BENCH_API_KEY（模型 API key）、BENCH_MODEL（默认 deepseek-flash）、BENCH_EFFORT（默认 low）、BENCH_OUT
// 只打印 ✓/✗、对比表和花费；逐题记录（含回复）写到结果目录。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { anthropicClient } from '../p0/run.js'
import { locomoTable, pickCases, runLocomo, runSystem, table, type LocomoResult, type SystemResult } from './run.js'
import { fromLocomo, type LocomoSample } from './locomo.js'
import { runLifeFull } from '../lifesim/full.js'
import { lifeTable, runLife, type LifeResult } from '../lifesim/run.js'
import { buildWorld, worldVersion } from '../lifesim/world.js'
import { SYSTEMS, systemById } from './systems.js'
import { buildTranscript, renderSessions, SIZES } from './transcript.js'
import { steady } from './steady.js'

const arg = (k: string) => {
  const i = process.argv.indexOf(k)
  return i > 0 ? process.argv[i + 1] : undefined
}
const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)

const baseUrl = process.env.BENCH_BASE_URL
const apiKey = process.env.BENCH_API_KEY
if (!baseUrl || !apiKey) {
  console.error('缺少 BENCH_BASE_URL / BENCH_API_KEY')
  process.exit(2)
}
const modelName = process.env.BENCH_MODEL ?? 'deepseek-flash'
// 断线保护（steady.ts）：连不上就停，不把空回答记成答错
const model = steady(anthropicClient({ baseUrl, apiKey, model: modelName, effort: process.env.BENCH_EFFORT ?? 'low', maxTokens: 1024 }))
const ingestModel = steady(anthropicClient({ baseUrl, apiKey, model: modelName, effort: 'high', maxTokens: 8192 }))

// ---------- 100 天生活模拟器（快速档）：--dataset lifesim --seed 1 [--days 100] ----------
if (arg('--dataset') === 'lifesim') {
  const seed = Number(arg('--seed') ?? '1')
  const days = arg('--days') ? Number(arg('--days')) : undefined
  const w = buildWorld(seed, { v: worldVersion(arg('--world-v')), volume: arg('--volume') === 'L' ? 'L' : 'S' })
  // 完整档：她真作答、上下文累积、超过阈值压缩（只测我们的系统；开关用 --switches ABCD）
  if (arg('--mode') === 'full') {
    const sws = arg('--switches') ?? ''
    const switches = { detail: sws.includes('A'), privacy: sws.includes('B'), askFirst: sws.includes('C'), time: sws.includes('D'), associate: sws.includes('H'), changes: sws.includes('I'), loose: sws.includes('F'), mid: sws.includes('M'), inject: sws.includes('J'), followTrigger: sws.includes('K'), lean: sws.includes('N'), prerecall: sws.includes('R'), verify: sws.includes('V'), weight: sws.includes('W'), synonyms: sws.includes('S'), slots: sws.includes('Y'), crisis: sws.includes('Z'), card: sws.includes('T'), v051: sws.includes('L'), ...(arg('--prefix') ? { prefix: arg('--prefix') as 'P46' | 'P100' | 'P200' | 'Pall' } : {}) }
    const threshold = arg('--threshold') ? Number(arg('--threshold')) : undefined
    console.log(`== 100 天生活模拟器（完整档）· 种子 ${seed} · ${days ?? w.days.length} 天 · 开关 ${sws || '无'} · 压缩阈值 ${threshold ?? 20000} token · 模型 ${modelName} ==`)
    const r = await runLifeFull(model, ingestModel, w, { ...(days ? { days } : {}), ...(threshold ? { threshold } : {}), ...(arg('--checkpoint') ? { checkpoint: arg('--checkpoint')! } : {}), switches, log: (l) => console.log(l) })
    console.log('\n' + lifeTable([r]) + `\n\n压缩次数：${JSON.stringify(r.compactions)}`)
    const out = process.env.BENCH_OUT ?? join(process.cwd(), 'bench', 'results')
    mkdirSync(out, { recursive: true })
    const file = join(out, `lifesim-full-v${arg('--world-v') ?? '1'}${arg('--volume') ?? 'S'}-s${seed}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, JSON.stringify({ seed, mode: 'full', switches: sws, threshold, model: modelName, results: [r] }, null, 2))
    console.log(`\n逐题记录：${file}`)
    process.exit(0)
  }
  const systems = list(arg('--systems') ?? 'full,ours')
  // 快照 / 回放：--save-store <目录> 建记忆时存下每个考题日的记忆（只能一个系统）；
  // --replay-store <目录> 不建记忆，各系统从同一份快照答题（写侧开关必须一致）
  const save = arg('--save-store')
  const replay = arg('--replay-store')
  if (save && systems.length !== 1) { console.error('--save-store 一次只能跑一个系统'); process.exit(2) }
  for (const id of systems) if (!systemById(id)) { console.error(`没有这个系统：${id}`); process.exit(2) }
  console.log(`== 100 天生活模拟器（快速档）· 种子 ${seed} · ${days ?? w.days.length} 天 · ${w.people.length} 个人 · 考题 ${w.probes.filter((p) => p.day <= (days ?? 1e9)).length} 道 · 模型 ${modelName} · 系统 ${systems.join(', ')}${replay ? ` · 回放 ${replay}` : ''}${save ? ` · 存快照 ${save}` : ''} ==`)
  const results: LifeResult[] = []
  for (const id of systems) {
    console.log(`\n-- ${id}`)
    // --only crisis,goodbye：只答这几类题（配合 --replay-store 省钱：只改了读侧某一块时只重答受影响的题类）
    const only = arg('--only')?.split(',').map((s) => s.trim()).filter(Boolean)
    results.push(await runLife(systemById(id)!, w, { model, ingestModel }, { ...(days ? { days } : {}), ...(save ? { save } : {}), ...(replay ? { replay } : {}), ...(only?.length ? { only } : {}), log: (l) => console.log(l) }))
  }
  console.log('\n' + lifeTable(results))
  const out = process.env.BENCH_OUT ?? join(process.cwd(), 'bench', 'results')
  mkdirSync(out, { recursive: true })
  const file = join(out, `lifesim-v${arg('--world-v') ?? '1'}${arg('--volume') ?? 'S'}-s${seed}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify({ seed, days: days ?? w.days.length, model: modelName, systems, ...(replay ? { replay } : {}), ...(save ? { save } : {}), results }, null, 2))
  console.log(`\n逐题记录：${file}`)
  process.exit(0)
}

// ---------- 公开基准 LoCoMo：--dataset locomo --conv 0,1（数据路径 LOCOMO_PATH，不入库） ----------
if (arg('--dataset') === 'locomo') {
  const path = process.env.LOCOMO_PATH
  if (!path) { console.error('缺少 LOCOMO_PATH（locomo10.json 的路径）'); process.exit(2) }
  const all = JSON.parse(readFileSync(path, 'utf8')) as LocomoSample[]
  const convs = list(arg('--conv') ?? '0').map(Number)
  const systems = list(arg('--systems') ?? 'none,full,bm25,ours')
  const judgeModel = anthropicClient({ baseUrl, apiKey, model: modelName, effort: 'low', maxTokens: 256 })
  const perConv: Array<{ conv: string; results: LocomoResult[] }> = []
  for (const i of convs) {
    const set = fromLocomo(all[i]!)
    const lim = arg('--max-q') ? Number(arg('--max-q')) : undefined
    if (lim) set.questions = set.questions.slice(0, lim)
    console.log(`== LoCoMo 第 ${i} 段（${set.transcript.sessions.length} 次对话，${set.questions.length} 题，其中对抗 ${set.questions.filter((q) => q.adversarial).length}）· 模型 ${modelName} · 系统 ${systems.join(', ')} ==`)
    const results: LocomoResult[] = []
    for (const id of systems) {
      const sys = systemById(id)!({ t: set.transcript, model, ingestModel })
      console.log(`\n-- ${id}：${sys.note}`)
      results.push(await runLocomo(sys, set, judgeModel, (line) => console.log(line)))
    }
    console.log('\n' + locomoTable(results))
    perConv.push({ conv: set.transcript.version, results })
  }
  const out = process.env.BENCH_OUT ?? join(process.cwd(), 'bench', 'results')
  mkdirSync(out, { recursive: true })
  const file = join(out, `locomo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify({ model: modelName, systems, convs, perConv }, null, 2))
  console.log(`\n逐题记录：${file}`)
  process.exit(0)
}

const size = (arg('--size') ?? 'S') as keyof typeof SIZES
if (!SIZES[size]) {
  console.error('--size 只能是 S 或 L')
  process.exit(2)
}
const t = buildTranscript(undefined, SIZES[size])
const cases = pickCases(t, { only: list(arg('--only')), ...(arg('--per-cat') ? { perCat: Number(arg('--per-cat')) } : {}) })
const systems = list(arg('--systems') ?? 'none,full,bm25,ours')
for (const s of systems) if (!systemById(s)) { console.error(`没有这个系统：${s}（有：${Object.keys(SYSTEMS).join(', ')}）`); process.exit(2) }

console.log(`== 记忆基准：${t.version} · ${size} 版（${t.sessions.length} 段对话，约 ${[...renderSessions(t)].length} 字）· ${cases.length} 题 · 模型 ${modelName} · 系统 ${systems.join(', ')} ==`)
const results: SystemResult[] = []
for (const id of systems) {
  const sys = systemById(id)!({ t, model, ingestModel })
  console.log(`\n-- ${id}：${sys.note}`)
  const r = await runSystem(sys, t, cases, (line) => console.log(line))
  results.push(r)
  console.log(`  [${id}] 总体 ${Math.round(r.accuracy * 100)}% · 建记忆约 ¥${r.cost.ingest.toFixed(3)} · 答题约 ¥${r.cost.answer.toFixed(3)}`)
}

console.log('\n==== 对比（同一个底座模型、同一批题；花费按 flash 闲时价估算，以服务商账单为准）====\n')
console.log(table(results))
const out = process.env.BENCH_OUT ?? join(process.cwd(), 'bench', 'results')
mkdirSync(out, { recursive: true })
const file = join(out, `membench-${size}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify({ version: t.version, size, model: modelName, systems, cases: cases.map((c) => c.id), results }, null, 2))
console.log(`\n逐题记录：${file}`)
