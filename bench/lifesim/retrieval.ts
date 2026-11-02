// 离线检索评测。不调模型、不花钱。
//   tsx bench/lifesim/retrieval.ts --snap <快照目录> --seed 11 --world-v 3 [--keys <同义键 JSON>]
// 做法：每道考题，用“那天的快照”的副本（不碰原快照），拿考题原话去翻：
//   - 工具路（recall_memory，limit 5）和预翻路（preRecall，不门控，k 6）各翻一次；
//   - 召回@5：库里确实记着答案（当时看得到的记忆里有标准答案的词）的题里，翻出来的前 5 条里带着答案的比例；
//   - 伪记忆：没提过 / 拒伪题平均翻出几条（越少越不容易顺着编）。
// --keys：{ 记忆编号: [键…] }（backfill-keys.ts 生成），先写进副本再翻——量同义键 Y 的效果。
// --export <json>：另把每道题的候选记忆、BM25+键 的排序与分数、两条路真实翻出的编号写成 JSON（离线对比向量检索用；默认输出不变）。
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { hardCue, MemoryStore, OWNER_ID, relatedTerms, tokenize, type Viewer } from '@dsh-companion/memory'
import { snapDir } from './run.js'
import { buildWorld, worldVersion, type Probe } from './world.js'

/** 有标准答案、该翻得到的题型（错配、隐私、注入、危机等另有判法，不算在召回里） */
export const RECALLABLE = new Set(['stable', 'latest', 'paraphrase', 'date', 'history', 'chain', 'source', 'implicit', 'misattrib_ctrl', 'promise_closed'])
/** 伪记忆题：没提过 / 拒伪 */
export const PHANTOM = new Set(['never', 'false_premise'])

/**
 * 固定的“从没聊过”的问题（世界里每个种子只有 3 道伪记忆题，太少）：[问法, 主题词]。
 * 库里只要出现过主题词就跳过这题（保证真没提过）。量的是“没有相关的记忆时，翻出来几条不相干的”——越少越不容易顺着编。
 */
export const PHANTOM_ASKS: Array<[string, string[]]> = [
  ['我初恋叫什么名字来着？', ['初恋']], ['我雅思考了多少分来着？', ['雅思']], ['我身上那个纹身是什么图案？', ['纹身']],
  ['我小学班主任姓什么？', ['班主任']], ['我第一份工资是多少？', ['工资']], ['我最怕什么动物来着？', ['怕']],
  ['我会弹什么乐器？', ['乐器', '钢琴', '吉他']], ['我去过几个国家？', ['国家', '出国']], ['我高考考了多少分？', ['高考']],
  ['我支持哪个球队来着？', ['球队']], ['我买的那只股票叫什么？', ['股票', '基金']], ['我鞋码多大？', ['鞋码', '码']],
  ['我耳洞打了几个？', ['耳洞']], ['我驾照考了几次才过？', ['驾照']], ['我上次献血是什么时候？', ['献血']],
  ['我奶奶家养的那只鹅叫什么？', ['鹅']], ['我学过哪门外语？', ['外语', '日语', '法语', '韩语']], ['我最喜欢哪个季节？', ['季节', '春天', '夏天', '秋天', '冬天']],
  ['我小时候住的那条街叫什么？', ['街']], ['我那个网名叫什么来着？', ['网名']], ['我玩的那个游戏账号多少级了？', ['游戏', '账号']],
  ['我跟你说过的那个梦是什么来着？', ['梦']], ['我在哪家医院出生的？', ['出生']], ['我的幸运数字是几？', ['幸运']],
  ['我最讨厌吃什么？', ['讨厌']], ['我收藏的那套邮票是哪年的？', ['邮票']], ['我参加过的那个马拉松跑了多久？', ['马拉松']],
  ['我那辆自行车是什么牌子？', ['自行车']], ['我大学宿舍几号楼？', ['宿舍']], ['我第一次坐飞机去的哪？', ['飞机']],
]

/** 标准答案在不在这些文字里：每组至少一个说法出现 */
export const hasAnswer = (texts: string[], keywords: string[][]) => {
  const t = texts.join('\n').replace(/\s+/g, '').toLowerCase()
  return keywords.length > 0 && keywords.every((g) => g.some((k) => t.includes(k.replace(/\s+/g, '').toLowerCase())))
}

const visibleTo = (vis: string, v: Viewer) =>
  vis === 'public' || vis === 'self' || vis === `person:${v.person}` || (vis.startsWith('people:') && vis.slice(7).split(',').includes(v.person))

export interface RetrievalRow {
  id: string; category: string; answerable: boolean; tool: boolean; pre: boolean; returned: number
  /** 两条路各翻出的编号，按返回顺序（--export 用） */
  toolIds?: string[]; preIds?: string[]
}

export function evalProbe(store: MemoryStore, p: Probe, now: Date, names: string[]): RetrievalRow {
  const v: Viewer = { person: p.asker, channel: 'private' }
  const kw = (p.keywords ?? []) as string[][]
  const all = (store.db.prepare('SELECT content, visibility FROM memory WHERE superseded_at IS NULL').all() as Array<{ content: string; visibility: string }>)
    .filter((m) => visibleTo(m.visibility, v)).map((m) => m.content)
  const answerable = RECALLABLE.has(p.category) && hasAnswer(all, kw)
  const contentOf = (id: string) => store.get(id)?.content ?? ''
  const tool = store.recall({ query: p.ask, limit: 5 }, v, now)
  const pre = store.preRecall(p.ask, v, now, { cue: hardCue(p.ask, names), dryRun: true, noGate: true, k: 6 })
  return {
    id: p.id, category: p.category, answerable,
    tool: answerable && hasAnswer(tool.items.map((it) => contentOf(it.id)), kw),
    pre: answerable && hasAnswer(pre.items.map((it) => it.row.content), kw),
    returned: tool.items.length,
    toolIds: tool.items.map((it) => it.id),
    preIds: pre.items.map((it) => it.row.id),
  }
}

/** 把同义键写进库（和线上回填同一条路：store.setKeys；按记忆的可见范围选一个看得到它的人） */
export function applyKeys(store: MemoryStore, keys: Record<string, string[]>): number {
  let n = 0
  for (const m of store.db.prepare("SELECT id, visibility FROM memory WHERE search_keys = '[]'").all() as Array<{ id: string; visibility: string }>) {
    const k = keys[m.id]
    if (!k?.length) continue
    const person = m.visibility.startsWith('person:') ? m.visibility.slice(7) : m.visibility.startsWith('people:') ? m.visibility.slice(7).split(',')[0]! : OWNER_ID
    if (store.setKeys(m.id, k, { person, channel: 'private' }).ok) n++
  }
  return n
}

/** 从没聊过的问题：库里（老大看得到的）出现过主题词的跳过；返回每题翻出的条数 */
export function phantomReturned(store: MemoryStore, now: Date): number[] {
  const v: Viewer = { person: OWNER_ID, channel: 'private' }
  const all = (store.db.prepare('SELECT content, visibility FROM memory').all() as Array<{ content: string; visibility: string }>)
    .filter((m) => visibleTo(m.visibility, v)).map((m) => m.content).join('\n')
  return PHANTOM_ASKS.filter(([, topic]) => !topic.some((t) => all.includes(t))).map(([ask]) => store.recall({ query: ask, limit: 5 }, v, now).items.length)
}

// ---------- --export：把每道题的候选与 BM25+键 的排序写成 JSON（离线对比向量检索用；不改默认输出） ----------

/** 和 store.ts 里的 BM25 / ftsExpr 一致（那边没导出；这里只用于离线对比，不进线上） */
const BM25_SQL = 'bm25(memory_fts, 0.0, 1.0, 0.5)'
const ftsPhrase = (t: string) => `"${t.replace(/"/g, '""')}"`
const ftsExpr = (tokens: string[], keys: string[] = []) =>
  [tokens.length ? `tokens : (${tokens.map(ftsPhrase).join(' OR ')})` : '', keys.length ? `key_tokens : (${keys.map(ftsPhrase).join(' OR ')})` : ''].filter(Boolean).join(' OR ')
/** recall 用到的几个私有方法（只读） */
type StoreInternals = { informative(tokens: string[]): string[]; keysIn(text: string): string[]; visibleClause(v: Viewer): { sql: string; args: string[] } }

export interface ExportMemory { id: string; content: string; gist: string | null; search_keys: string[]; recorded_at: string; occurred_at: string | null; about: string; importance: string; visibility: string; superseded: boolean }
export interface ExportRanked { id: string; score: number; via: 'own' | 'rel' }
export interface ExportProbe {
  id: string; category: string; tag: string | null; ask: string; day: number; told_day: number; asker: string; now: string
  keywords: string[][]; answerable: boolean
  query_tokens: string[]; key_hits: string[]
  /** 那天 viewer 看得到、没被替代的全部记忆（编号；内容在 memories 里） */
  candidate_ids: string[]
  /** 镜像 recall 工具路的排序：own = 原词 + 整词同义键，rel = 相关说法；分数取负 bm25，越大越相关 */
  bm25: ExportRanked[]
  /** 真实 recall(limit 5) / preRecall(k 6) 翻出的编号 */
  tool_top5: string[]; pre_top6: string[]
}
export interface ExportPhantom { ask: string; topics: string[]; skipped: boolean; bm25: ExportRanked[]; tool_top5: string[] }

/** 镜像 recall 工具路的排序（不含被替代的；真实 recall 把被替代的排最后，前 5 条只在不足 5 条时才会不同） */
export function bm25Ranking(store: MemoryStore, query: string, v: Viewer, limit = 50): { tokens: string[]; keys: string[]; ranked: ExportRanked[] } {
  const s = store as unknown as StoreInternals
  const tokens = s.informative(tokenize(query))
  const keys = s.keysIn(query)
  if (tokens.length === 0 && keys.length === 0) return { tokens, keys, ranked: [] }
  const vis = s.visibleClause(v)
  const q = store.db.prepare(`SELECT m.id AS id, ${BM25_SQL} AS score FROM memory_fts JOIN memory m ON m.id = memory_fts.id
    WHERE memory_fts MATCH ? AND m.superseded_at IS NULL AND ${vis.sql} ORDER BY score, m.recorded_at DESC LIMIT ?`)
  const find = (ts: string[], ks: string[], via: 'own' | 'rel'): ExportRanked[] =>
    ts.length === 0 && ks.length === 0 ? [] : (q.all(ftsExpr(ts, ks), ...vis.args, limit) as Array<{ id: string; score: number }>).map((r) => ({ id: r.id, score: -r.score, via }))
  const own = find(tokens, keys, 'own')
  const rel = find(s.informative(tokenize(relatedTerms(query).join(' '))).filter((t) => !tokens.includes(t)), [], 'rel')
  const seen = new Set<string>()
  return { tokens, keys, ranked: [...own, ...rel].filter((r) => !seen.has(r.id) && seen.add(r.id)) }
}

/** viewer 看得到、没被替代的全部记忆（和 evalProbe 判 answerable 用的集合一致） */
export function candidatesFor(store: MemoryStore, v: Viewer): ExportMemory[] {
  return (store.db.prepare('SELECT id, content, gist, search_keys, recorded_at, occurred_at, about, importance, visibility FROM memory WHERE superseded_at IS NULL ORDER BY recorded_at').all() as Array<Omit<ExportMemory, 'search_keys' | 'superseded'> & { search_keys: string }>)
    .filter((m) => visibleTo(m.visibility, v))
    .map((m) => ({ ...m, search_keys: JSON.parse(m.search_keys || '[]') as string[], superseded: false }))
}

/** 真实两条路翻出的、不在候选里的条目（被替代的旧条，recall 排在最后）：也带上内容，离线算"现状"时口径才和 evalProbe 一样 */
function addOutside(store: MemoryStore, ids: string[], memories: Map<string, ExportMemory>): void {
  for (const id of ids) {
    if (memories.has(id)) continue
    const m = store.get(id)
    if (!m) continue
    memories.set(id, {
      id, content: m.content, gist: m.gist, search_keys: JSON.parse(m.search_keys || '[]') as string[], recorded_at: m.recorded_at, occurred_at: m.occurred_at,
      about: m.about, importance: m.importance, visibility: m.visibility, superseded: !!m.superseded_at,
    })
  }
}

/** 从没聊过的问题：和 phantomReturned 同一套判法（主题词出现过的标 skipped），另带排序 */
export function exportPhantom(store: MemoryStore, now: Date): { candidates: ExportMemory[]; asks: ExportPhantom[] } {
  const v: Viewer = { person: OWNER_ID, channel: 'private' }
  const all = (store.db.prepare('SELECT content, visibility FROM memory').all() as Array<{ content: string; visibility: string }>)
    .filter((m) => visibleTo(m.visibility, v)).map((m) => m.content).join('\n')
  return {
    candidates: candidatesFor(store, v),
    asks: PHANTOM_ASKS.map(([ask, topics]) => ({
      ask, topics, skipped: topics.some((t) => all.includes(t)),
      bm25: bm25Ranking(store, ask, v).ranked,
      tool_top5: store.recall({ query: ask, limit: 5 }, v, now).items.map((it) => it.id),
    })),
  }
}

export function summarize(rows: RetrievalRow[]) {
  const ans = rows.filter((r) => r.answerable)
  const ph = rows.filter((r) => PHANTOM.has(r.category))
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%（${n}/${d}）` : '—')
  return {
    toolAt5: pct(ans.filter((r) => r.tool).length, ans.length),
    preAt6: pct(ans.filter((r) => r.pre).length, ans.length),
    phantomReturned: ph.length ? Math.round((ph.reduce((s, r) => s + r.returned, 0) / ph.length) * 100) / 100 : NaN,
    phantomAny: pct(ph.filter((r) => r.returned > 0).length, ph.length),
    byCategory: [...new Set(ans.map((r) => r.category))].map((c) => ({ c, tool: pct(ans.filter((r) => r.category === c && r.tool).length, ans.filter((r) => r.category === c).length) })),
  }
}

if (process.argv[1] && /retrieval\.(ts|mjs|js)$/.test(process.argv[1])) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
  const snap = arg('--snap')
  const seed = Number(arg('--seed') ?? '11')
  if (!snap) { console.error('要给 --snap <快照目录>'); process.exit(2) }
  const wv = arg('--world-v') ?? '3'
  const volume = (arg('--volume') ?? 'L') === 'L' ? 'L' : 'S'
  const w = buildWorld(seed, { v: worldVersion(wv, 3), volume })
  const keys = arg('--keys') ? (JSON.parse(readFileSync(arg('--keys')!, 'utf8')) as Record<string, string[]>) : undefined
  const exportPath = arg('--export')
  const names = w.people.map((p) => p.name)
  const tmp = mkdtempSync(join(tmpdir(), 'retrieval-'))
  const rows: RetrievalRow[] = []
  const exported: ExportProbe[] = []
  const memories = new Map<string, ExportMemory>()
  try {
    for (const p of w.probes) {
      const src = snapDir(snap, p.day)
      if (!existsSync(join(src, 'memory.db'))) continue
      const dst = join(tmp, `d${p.day}`)
      if (!existsSync(dst)) cpSync(src, dst, { recursive: true })
      const store = MemoryStore.open(join(dst, 'memory.db'), { ownerName: '老大' })
      try {
        if (keys) applyKeys(store, keys)
        const date = w.days.find((d) => d.day === p.day)!.date
        const now = new Date(`${date}T21:00:00+08:00`)
        const row = evalProbe(store, p, now, names)
        rows.push(row)
        if (exportPath) {
          const v: Viewer = { person: p.asker, channel: 'private' }
          const cands = candidatesFor(store, v)
          for (const m of cands) memories.set(m.id, m)
          addOutside(store, [...(row.toolIds ?? []), ...(row.preIds ?? [])], memories)
          const { tokens, keys: keyHits, ranked } = bm25Ranking(store, p.ask, v)
          exported.push({
            id: p.id, category: p.category, tag: p.tag ?? null, ask: p.ask, day: p.day, told_day: p.toldDay, asker: p.asker, now: now.toISOString(),
            keywords: (p.keywords ?? []) as string[][], answerable: row.answerable, query_tokens: tokens, key_hits: keyHits,
            candidate_ids: cands.map((m) => m.id), bm25: ranked, tool_top5: row.toolIds ?? [], pre_top6: row.preIds ?? [],
          })
        }
      } finally {
        store.close()
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  // 从没聊过的问题：用最后一份快照
  const lastDay = [...w.days].reverse().find((d) => existsSync(join(snapDir(snap, d.day), 'memory.db')))
  let phantom: number[] = []
  let phantomExport: { day: number; now: string; candidate_ids: string[]; asks: ExportPhantom[] } | undefined
  if (lastDay) {
    const tmp2 = mkdtempSync(join(tmpdir(), 'retrieval-ph-'))
    try {
      cpSync(snapDir(snap, lastDay.day), tmp2, { recursive: true })
      const store = MemoryStore.open(join(tmp2, 'memory.db'), { ownerName: '老大' })
      if (keys) applyKeys(store, keys)
      const now = new Date(`${lastDay.date}T21:00:00+08:00`)
      phantom = phantomReturned(store, now)
      if (exportPath) {
        const ph = exportPhantom(store, now)
        for (const m of ph.candidates) memories.set(m.id, m)
        addOutside(store, ph.asks.flatMap((a) => a.tool_top5), memories)
        phantomExport = { day: lastDay.day, now: now.toISOString(), candidate_ids: ph.candidates.map((m) => m.id), asks: ph.asks }
      }
      store.close()
    } finally {
      rmSync(tmp2, { recursive: true, force: true })
    }
  }
  if (exportPath) {
    writeFileSync(exportPath, JSON.stringify({
      seed, world_v: wv, volume, snap: basename(snap), keys_applied: !!keys, exported_at: new Date().toISOString(),
      probes: exported, phantom: phantomExport, memories: Object.fromEntries(memories),
    }), 'utf8')
    console.log(`已导出 ${exported.length} 道题 · ${memories.size} 条记忆 · 从没聊过的问题 ${phantomExport?.asks.length ?? 0} 道 → ${exportPath}`)
  }
  const s = summarize(rows)
  console.log(`== 离线检索 · 种子 ${seed} · 世界 v${wv} · 考题 ${rows.length} 道${keys ? ` · 同义键 ${Object.keys(keys).length} 条` : ''} ==`)
  console.log(`召回（库里有答案的 ${rows.filter((r) => r.answerable).length} 题）：工具前 5 条 ${s.toolAt5} · 预翻前 6 条 ${s.preAt6}`)
  console.log(`伪记忆题：平均翻出 ${s.phantomReturned} 条 · 翻出至少 1 条的 ${s.phantomAny}`)
  console.log(`从没聊过的问题（${phantom.length} 道，第 ${lastDay?.day} 天的库）：平均翻出 ${phantom.length ? (phantom.reduce((a, b) => a + b, 0) / phantom.length).toFixed(2) : '—'} 条 · 翻出至少 1 条的 ${phantom.filter((n) => n > 0).length}/${phantom.length}`)
  console.log('分题型（工具路）：' + s.byCategory.map((x) => `${x.c} ${x.tool}`).join(' · '))
}
