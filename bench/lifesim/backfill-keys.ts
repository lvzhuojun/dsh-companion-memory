// 同义键回填（开关 S）：给已有记忆补写“别人以后可能怎么问”的词。
//   MEMBENCH_SCRIPT=bench/lifesim/backfill-keys.ts bash membench-steady.sh --snap <快照目录> --out <keys.json>
// 读快照最后一天的记忆库（只读副本），每批 30 条交给模型（同一个人看得到的放一批，不把不同人的记忆混在一次里），
// 输出 { 记忆编号: [键…] }。线上回填用同一份提示词，结果经 store.setKeys 写入（只能写一次）。
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanKeys, MEMORY_KEY_CHARS, MEMORY_KEYS_MAX, MemoryStore } from '@dsh-companion/memory'
import { steady } from '../membench/steady.js'
import { anthropicClient, type ModelClient } from '../p0/run.js'

export const BATCH = 30

export function backfillPrompt(items: Array<{ id: string; content: string }>): string {
  return '下面是我以前记下的几条记忆。给每条写 2–' + MEMORY_KEYS_MAX + ' 个“以后别人可能怎么问到这件事”的词（每个 ' + MEMORY_KEY_CHARS + ' 字以内），' +
    '比如记的是“老大是 AB 型血”，可以写“血型”“什么血”；记的是“老大开比亚迪”，可以写“车”“开什么车”。' +
    '原话里已经有的词不用写；“事情”“东西”“生活”这种几乎每条都能挂上的泛词别写；不知道怎么写就给空数组。\n' +
    '只输出一个 JSON 对象，键是编号、值是词的数组，不要别的话。\n\n' +
    items.map((m) => `[${m.id}] ${m.content}`).join('\n')
}

/** 从模型回复里取出 JSON（容忍代码块包裹），只留请求里有的编号，键过一遍泛词过滤 */
export function parseKeys(text: string, ids: Set<string>): Record<string, string[]> {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return {}
  let raw: unknown
  try { raw = JSON.parse(m[0]) } catch { return {} }
  const out: Record<string, string[]> = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ids.has(id)) continue
    const keys = cleanKeys(v).filter((k) => [...k].length <= MEMORY_KEY_CHARS)
    if (keys.length) out[id] = keys
  }
  return out
}

export async function backfill(model: ModelClient, rows: Array<{ id: string; content: string; visibility: string }>, log: (l: string) => void = () => {}) {
  const groups = new Map<string, Array<{ id: string; content: string }>>()
  for (const r of rows) groups.set(r.visibility, [...(groups.get(r.visibility) ?? []), { id: r.id, content: r.content }])
  const out: Record<string, string[]> = {}
  let calls = 0
  for (const [vis, items] of groups) {
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH)
      const r = await model.complete({ system: '现在是我自己整理以前的记忆，没有人在等我回复。', messages: [{ role: 'user', content: backfillPrompt(batch) }] } as never)
      calls++
      const text = (r.content as Array<{ type: string; text?: string }>).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
      const got = parseKeys(text, new Set(batch.map((b) => b.id)))
      Object.assign(out, got)
      log(`  ${vis} 第 ${i / BATCH + 1} 批：${batch.length} 条，写了键的 ${Object.keys(got).length} 条`)
    }
  }
  return { keys: out, calls }
}

if (process.argv[1] && /backfill-keys\.(ts|mjs|js)$/.test(process.argv[1])) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
  const snap = arg('--snap')
  const outFile = arg('--out')
  const baseUrl = process.env.BENCH_BASE_URL
  const apiKey = process.env.BENCH_API_KEY
  if (!snap || !outFile || !baseUrl || !apiKey) { console.error('要给 --snap <快照目录> --out <keys.json>，并设 BENCH_BASE_URL / BENCH_API_KEY'); process.exit(2) }
  const days = readdirSync(snap).filter((d) => /^day-\d+$/.test(d) && existsSync(join(snap, d, 'memory.db'))).sort()
  const last = days.at(-1)
  if (!last) { console.error('快照目录里没有 day-NNN'); process.exit(2) }
  const tmp = mkdtempSync(join(tmpdir(), 'backfill-'))
  try {
    cpSync(join(snap, last), tmp, { recursive: true })
    const store = MemoryStore.open(join(tmp, 'memory.db'), { ownerName: '老大' })
    const rows = store.db.prepare('SELECT id, content, visibility FROM memory WHERE superseded_at IS NULL ORDER BY recorded_at').all() as Array<{ id: string; content: string; visibility: string }>
    store.close()
    // 夜间回顾用 high 思考
    const model = steady(anthropicClient({ baseUrl, apiKey, model: process.env.BENCH_MODEL ?? 'deepseek-flash', effort: 'high', maxTokens: 8192 }))
    console.log(`== 同义键回填 · ${snap} 的 ${last} · ${rows.length} 条 ==`)
    const r = await backfill(model, rows, (l) => console.log(l))
    writeFileSync(outFile, JSON.stringify(r.keys, null, 1))
    console.log(`写了键的 ${Object.keys(r.keys).length}/${rows.length} 条 · 调用 ${r.calls} 次 → ${outFile}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
