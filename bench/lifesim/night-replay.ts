// 单晚重放（诊断用）：从某天的快照出发，只跑下一天（或某几天）的夜间整理，打印她每一步调了什么工具、最后记下了什么。
//   MEMBENCH_SCRIPT=bench/lifesim/night-replay.ts bash membench-steady.sh --snap <快照目录> --seed 11 --world-v 3 \
//     --from-day 88 --day 89 --systems ours+ABCDIN,ours+ABCDI~v051 [--runs 2]
// 各系统从同一份快照出发（不管快照是哪个写侧建的），只比这一晚的写法。花费 = 每系统每晚一次夜间整理（约 ¥0.01–0.02）。
import { cpSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { steady } from '../membench/steady.js'
import { systemById } from '../membench/systems.js'
import { anthropicClient, type ModelClient } from '../p0/run.js'
import { sessionsOf, snapDir } from './run.js'
import { buildWorld, worldVersion } from './world.js'

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const snap = arg('--snap')
const seed = Number(arg('--seed') ?? '11')
const fromDay = Number(arg('--from-day'))
const day = Number(arg('--day'))
const runs = Number(arg('--runs') ?? '1')
const baseUrl = process.env.BENCH_BASE_URL
const apiKey = process.env.BENCH_API_KEY
if (!snap || !fromDay || !day || !baseUrl || !apiKey) { console.error('用法见文件头'); process.exit(2) }
if (!existsSync(join(snapDir(snap, fromDay), 'memory.db'))) { console.error(`没有 ${snapDir(snap, fromDay)}`); process.exit(2) }
const w = buildWorld(seed, { v: worldVersion(arg('--world-v'), 3), volume: (arg('--volume') ?? 'L') === 'L' ? 'L' : 'S' })
const model = steady(anthropicClient({ baseUrl, apiKey, model: 'deepseek-flash', effort: 'low', maxTokens: 1024 }))
const raw = steady(anthropicClient({ baseUrl, apiKey, model: 'deepseek-flash', effort: 'high', maxTokens: 8192 }))

/** 打印每一步的工具调用（名字 + 参数前 160 字） */
const logged = (m: ModelClient): ModelClient => ({
  async complete(req) {
    const msgs = (req as { messages: Array<{ content: unknown }> }).messages
    const watch = arg('--watch')
    if (watch && msgs.length === 1) {
      const text = JSON.stringify(msgs[0]!.content)
      console.log(`    （材料 ${text.length} 字；“${watch}”${text.includes(watch) ? '在材料里' : '不在材料里'}）`)
    }
    const r = await m.complete(req)
    const uses = (r.content as Array<{ type: string; name?: string; input?: unknown }>).filter((c) => c.type === 'tool_use')
    console.log(`    第 ${Math.ceil((req as { messages: unknown[] }).messages.length / 2)} 步：${uses.length ? uses.map((u) => `${u.name} ${JSON.stringify(u.input).slice(0, 160)}`).join('\n             ') : '（没调工具，结束）'}`)
    return r
  },
})

for (const id of (arg('--systems') ?? 'ours+ABCDIN').split(',')) {
  const make = systemById(id)
  if (!make) { console.error(`没有这个系统：${id}`); process.exit(2) }
  for (let k = 1; k <= runs; k++) {
    const t = { version: `lifesim-${w.seed}`, ownerName: '老大', now: `${w.days[day - 1]!.date}T21:00:00+08:00`, sessions: [], questions: [] }
    const sys = make({ model, ingestModel: logged(raw), t } as never)
    // 快照里记着“会话 bench 已整理到第几条”；重放时序号从 1 起，不清掉的话整晚都会被当成整理过而跳过
    const copy = mkdtempSync(join(tmpdir(), 'night-replay-'))
    cpSync(snapDir(snap, fromDay), copy, { recursive: true })
    const db = new DatabaseSync(join(copy, 'memory.db'))
    db.exec('DELETE FROM review_cursor')
    db.close()
    sys.load!(copy)
    console.log(`\n== ${id} 第 ${k} 次：从第 ${fromDay} 天的快照出发，整理第 ${day} 天（${w.days[day - 1]!.date}）`)
    for (let d = fromDay + 1; d <= day; d++) for (const s of sessionsOf(w, d)) {
      console.log(`  -- ${s.speaker?.name ?? '老大'} ${s.date} ${s.time}：${s.turns.filter((u) => u.who !== 'me').map((u) => u.text).join(' / ').slice(0, 200)}`)
      await sys.ingest(s)
    }
  }
}
process.exit(0)
