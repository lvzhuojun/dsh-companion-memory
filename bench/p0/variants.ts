// 被测版本：记忆规则 + 她手上的工具。题集用 --variant 选，改动前后用同一套题对比。
//   none     没有记忆：不给规则、不给任何工具（合成赛道的“无记忆”基线）
//   0.2.1    线上曾经的版本（规则冻结在 rules-0.2.1.ts），工具：翻日记、写日记
//   0.2.2    P0.3：说“记下了”就必须真的写成功；工具同上（规则冻结在 rules-0.3.0.ts 的 memory:false）
//   0.3.1    记忆库开，规则冻结在 rules-0.3.0.ts（“一处翻不到就翻另一处”）；recall_memory 只翻记忆库
//   0.3.4    0.3.2 – 0.3.4 线上：recall_memory 带关键词时顺带翻日记（一次翻两处）；fp06 措辞。规则冻结在 rules-0.3.2.ts
//   current  当前代码（0.4.0 起）：稳定层“我心里记得的”进系统提示 + follow_up（惦记的事）
// 工具一律是插件里真实的工具实现，指向临时生命目录（记忆库是临时目录里的 memory.db）。

import { followUpTool, keepMemoryTool, memoryRules, recallDiaryTool, recallMemoryTool, writeDiaryTool, type ToolDef } from '@dsh-companion/dsh-plugin'
import { diaryBooks, MemoryStore, OWNER_ID, stableLayer } from '@dsh-companion/memory'
import { join } from 'node:path'
import type { Dataset, FollowUpFixture, MemoryFixture } from './types.js'
import { memoryRules_0_2_1 } from './rules-0.2.1.js'
import { memoryRules_0_3_0 } from './rules-0.3.0.js'
import { memoryRules_0_3_2 } from './rules-0.3.2.js'

type Profile = Dataset['profile']

export interface Variant {
  id: string
  /** 有记忆库：题集的记忆库夹具写进 memory.db；没有的版本把它们写成私人日记（信息量相同，比较才公平） */
  memory: boolean
  rules(p: Profile): string
  /** 在临时生命目录上准备工具；close 在题目结束时调用（关闭记忆库文件） */
  /** now：题目里的“现在”——她写下东西的时间按它算，和时间行一致 */
  setup(life: string, p: Profile, now: () => Date, memories?: MemoryFixture[], followUps?: FollowUpFixture[]): Env
}

export interface Env {
  tools: ToolDef[]
  close(): void
  /** 稳定层（0.4.0 起）：当下生成的“我心里记得的”，接在规则后面；没有就是空串。换会话时重新生成（= 第二天） */
  context?: () => string
}

/** 会写下东西的工具：说“记下了”之前必须真的调用过其中一个，并且成功 */
export const WRITE_TOOLS = ['write_diary', 'keep_memory']
/** 翻回忆的工具 */
export const RECALL_TOOLS = ['recall_diary', 'recall_memory']

const books = (p: Profile) => diaryBooks({ ownerBook: p.ownerBook, ownerName: p.ownerName })
const diaryTools = (life: string, p: Profile, now: () => Date): ToolDef[] => [
  recallDiaryTool(life, books(p)),
  writeDiaryTool(life, books(p), { ownerName: p.ownerName, privateDiaryAudited: p.privateDiaryAudited, now }),
]
const diaryOnly = (life: string, p: Profile, now: () => Date) => ({ tools: diaryTools(life, p, now), close() {} })

/**
 * 记忆库开：日记两件 + keep_memory / recall_memory；alongside=true 时 recall_memory 顺带翻日记；
 * stable=true（0.4.0 起）：再加 follow_up，并生成稳定层
 */
const withMemory = (alongside: boolean, stable = false, dates = false) => (life: string, p: Profile, now: () => Date, memories: MemoryFixture[] = [], followUps: FollowUpFixture[] = []): Env => {
  const store = MemoryStore.open(join(life, 'memory.db'), { ownerName: p.ownerName })
  const viewer = () => ({ person: OWNER_ID, channel: 'private' })
  for (const m of memories) {
    const r = store.keep({ content: m.content, importance: m.importance, about: m.about, kind: m.kind }, { viewer: viewer(), sourceRef: { via: 'fixture' }, now: new Date(`${m.date}T${m.time}:00+08:00`) })
    if (!r.ok) throw new Error(`记忆库夹具写不进去：${r.reason}`)
    if (m.forgotten) store.forget(r.id, 'her', '老大让我忘掉', new Date(`${m.date}T23:00:00+08:00`))
  }
  const recall = recallMemoryTool(store, viewer, now, alongside ? { lifeDir: life, books: books(p) } : undefined)
  const tools = [...diaryTools(life, p, now), keepMemoryTool(store, viewer, p.ownerName, now), recall]
  if (!stable) return { tools, close: () => store.close() }
  for (const f of followUps) {
    const r = store.followUp({ what: f.what, askAfter: f.askAfter, ...(f.giveUpAfter ? { giveUpAfter: f.giveUpAfter } : {}) }, { viewer: viewer(), now: new Date(`${f.created}T21:00:00+08:00`) })
    if (!r.ok) throw new Error(`惦记的事夹具写不进去：${r.reason}`)
    for (const d of f.asked ?? []) store.markFollowUp(r.id, 'asked', viewer(), { now: new Date(`${d}T21:00:00+08:00`) })
    if (f.status) store.markFollowUp(r.id, f.status, viewer(), { ...(f.outcome ? { outcome: f.outcome } : {}), now: new Date(`${f.closed ?? f.created}T22:00:00+08:00`) })
  }
  return {
    tools: [...tools, followUpTool(store, viewer, now)],
    close: () => store.close(),
    context: () => stableLayer(store, viewer(), now(), { ownerName: p.ownerName, dates }),
  }
}

export const variants: Record<string, Variant> & { current: Variant } = {
  none: { id: 'none', memory: false, rules: () => '', setup: () => ({ tools: [], close() {} }) },
  '0.2.1': { id: '0.2.1', memory: false, rules: memoryRules_0_2_1, setup: diaryOnly },
  '0.2.2': { id: '0.2.2', memory: false, rules: (p) => memoryRules_0_3_0({ ...p, memory: false }), setup: diaryOnly },
  '0.3.1': { id: '0.3.1', memory: true, rules: (p) => memoryRules_0_3_0({ ...p, memory: true }), setup: withMemory(false) },
  '0.3.4': { id: '0.3.4', memory: true, rules: (p) => memoryRules_0_3_2({ ...p, memory: true }), setup: withMemory(true) },
  current: { id: '0.4.0', memory: true, rules: (p) => memoryRules({ ...p, memory: true }), setup: withMemory(true, true) },
  // 0.5.0 候选（第二阶段开关 C、D 开；A、B 在夜间回顾里，这个题集不经过夜间回顾）
  '0.5.0': { id: '0.5.0', memory: true, rules: (p) => memoryRules({ ...p, memory: true, askFirst: true, timeCalc: true }), setup: withMemory(true, true, true) },
}
