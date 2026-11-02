// 把合成赛道的世界（world.ts）变成题集运行器认识的 Dataset：日记夹具、记忆库夹具、档案、题目。
// 纯函数、确定性：同一份 world.ts 永远生成同一份题集。

import type { Case, Category, Dataset, DiaryFixture, MemoryFixture } from '../p0/types.js'
import { SYNTH_NOW, SYNTH_VERSION, WORLD, type Evidence, type SynthCategory, type SynthItem } from './world.js'

const CATEGORY: Record<SynthCategory, Category> = {
  recall: 'fact_recall', update: 'fact_update', temporal: 'temporal', promise: 'promise', emotion: 'emotion',
  false_premise: 'false_premise', never: 'never_mentioned', privacy: 'privacy', forget: 'forget',
}

const full = (mmdd: string) => `2026-${mmdd}`

function toCase(it: SynthItem): Case {
  const category = CATEGORY[it.cat]
  const base = { id: it.id, category, note: `合成赛道 · ${it.cat}`, user: it.ask }
  switch (it.cat) {
    case 'false_premise':
      return { ...base, expect: { recall: 'required', answer: 'deny_false_premise', ...(it.correction ? { correction: it.correction } : {}) } }
    case 'never':
      return { ...base, expect: { recall: 'required', answer: 'admit_unknown' } }
    case 'privacy':
    case 'forget':
      // 不复述细节就算对（她可以说只记得个大概、说那是别人的私事、说忘掉了）
      return { ...base, expect: { recall: 'any', answer: 'admit_unknown', mustNot: it.mustNot! } }
    default:
      return { ...base, expect: { recall: 'required', answer: 'recall_fact', keywords: it.keywords!, ...(it.stale ? { stale: it.stale } : {}) } }
  }
}

export function buildSynth(): Dataset {
  const diary: DiaryFixture[] = []
  const memories: MemoryFixture[] = []
  const seen = new Set<string>()
  const minute = new Map<string, number>()
  const nextTime = (date: string) => {
    const n = minute.get(date) ?? 0
    minute.set(date, n + 1)
    return `${String(21 + Math.floor(n / 6)).padStart(2, '0')}:${String((n % 6) * 10).padStart(2, '0')}`
  }
  const add = (e: Evidence) => {
    const key = `${e.via}|${e.date}|${e.text}`
    if (seen.has(key)) return
    seen.add(key)
    const date = full(e.date)
    const time = nextTime(date)
    if (e.via === 'diary') {
      // 她自己的承诺、心里话写在私人日记；其余轮流写在两本里
      const book = /^我/.test(e.text) || diary.length % 2 === 1 ? 'private' : 'to_laoda'
      diary.push({ book, date, time, text: e.text })
    } else {
      memories.push({ date, time, content: e.text, importance: e.importance ?? '一般', about: e.about ?? '对方', kind: e.kind ?? '事实', ...(e.forgotten ? { forgotten: true } : {}) })
    }
  }
  for (const it of WORLD) for (const e of it.evidence ?? []) add(e)
  const archive = WORLD.flatMap((it) => (it.archive ?? []).map((a) => ({
    date: full(a.date),
    turns: [{ role: 'user' as const, text: a.owner }, ...(a.me ? [{ role: 'assistant' as const, text: a.me }] : [])],
  })))
  return {
    version: SYNTH_VERSION,
    now: SYNTH_NOW,
    profile: { ownerName: '老大', ownerBook: 'to_laoda', privateDiaryAudited: true },
    diary: diary.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    memories: memories.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    archive,
    cases: WORLD.map(toCase),
  }
}
