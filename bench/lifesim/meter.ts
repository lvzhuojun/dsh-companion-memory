// 成本分项计量：每次模型调用按用途记 次数 / 未命中 / 命中 / 输出。
// 用途：
//   chat / chat_tool     完整档白天：她答一句话的第一次调用 / 调了工具之后的续答
//   answer / answer_tool 快速档答题：同上
//   night / night_step   夜间回顾：每段第一步 / 后续步（步数 = night + night_step 的次数；每段步数 = 总 ÷ night）
//   compact              压缩
// 写进每天的统计时用扁平键（累计值，和 ingest / answer 一样）：m_<用途>_calls / _miss / _hit / _out。
// 只记数字，不记内容。
import type { ModelClient } from '../p0/run.js'

export type Purpose = 'chat' | 'chat_tool' | 'answer' | 'answer_tool' | 'night' | 'night_step' | 'compact'

export interface MeterRow { calls: number; miss: number; hit: number; out: number }

export class Meter {
  private rows = new Map<Purpose, MeterRow>()

  add(p: Purpose, u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined) {
    const r = this.rows.get(p) ?? { calls: 0, miss: 0, hit: 0, out: 0 }
    r.calls++
    r.miss += u?.input_tokens ?? 0
    r.hit += u?.cache_read_input_tokens ?? 0
    r.out += u?.output_tokens ?? 0
    this.rows.set(p, r)
  }

  /** 累计值，扁平键（进 DayStats） */
  snapshot(): Record<string, number> {
    const o: Record<string, number> = {}
    for (const [p, r] of this.rows) {
      o[`m_${p}_calls`] = r.calls
      o[`m_${p}_miss`] = r.miss
      o[`m_${p}_hit`] = r.hit
      o[`m_${p}_out`] = r.out
    }
    return o
  }

  /** 从 snapshot() 的扁平键恢复（完整档断点续跑） */
  static restore(flat: Record<string, number>): Meter {
    const m = new Meter()
    for (const [k, v] of Object.entries(flat)) {
      const x = /^m_(.+)_(calls|miss|hit|out)$/.exec(k)
      if (!x) continue
      const p = x[1] as Purpose
      const r = m.rows.get(p) ?? { calls: 0, miss: 0, hit: 0, out: 0 }
      r[x[2] as keyof MeterRow] = v
      m.rows.set(p, r)
    }
    return m
  }

  get(p: Purpose): MeterRow {
    return { ...(this.rows.get(p) ?? { calls: 0, miss: 0, hit: 0, out: 0 }) }
  }
}

type Req = Parameters<ModelClient['complete']>[0]

/** 这次请求是不是工具调用之后的续答（最后一条消息里有 tool_result） */
export function isToolFollowUp(req: Req): boolean {
  const last = req.messages[req.messages.length - 1]
  return !!last && Array.isArray(last.content) && (last.content as Array<{ type?: string }>).some((b) => b?.type === 'tool_result')
}

/** 包一层：按 label(req) 记到 meter */
export function metered(m: ModelClient, meter: Meter, label: (req: Req) => Purpose): ModelClient {
  return {
    async complete(req) {
      const r = await m.complete(req)
      meter.add(label(req), r.usage as never)
      return r
    },
  }
}

/** 常用的三种分法 */
export const byAnswer = (req: Req): Purpose => (isToolFollowUp(req) ? 'answer_tool' : 'answer')
export const byChat = (req: Req): Purpose => (isToolFollowUp(req) ? 'chat_tool' : 'chat')
export const byNight = (req: Req): Purpose => (req.messages.length <= 1 ? 'night' : 'night_step')

/** 从每天的累计计量算区间日均（rubric C2 / C3 与诊断用）：第 a–b 天某个字段的日均增量 */
export function dailyMean(days: Array<Record<string, number>>, key: string, a: number, b: number): number {
  const at = (d: number) => days.find((x) => x.day === d)?.[key] ?? 0
  const before = a > 1 ? at(a - 1) : 0
  return (at(b) - before) / (b - a + 1)
}
