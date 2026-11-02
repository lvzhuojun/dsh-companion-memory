// 读 DSH 会话日志（只读）。夜间回顾与部署检查共用。
//
// 格式（以 DSH 源码与实际日志为准）：
//   - 文件 $DSH_HOME/sessions/--<项目>--/<会话>/session.v4.jsonl.zstd，一批事件一个 zstd 帧，整个文件是多帧拼接；
//   - Node 的 zstdDecompressSync 只解第一个帧，所以按帧魔数切开逐帧解；
//   - 每行一个事件 {type, seq, time, data}；user/message 的 data.source.kind 区分来源：
//       user、plugin:dsh-qq-bridge  —— 真人说的话
//       time-context、runtime-context —— 系统注入，夜间回顾时剔除
//
// 设计原则：会话日志是档案，不是记忆。这里只给夜间回顾（她自己回顾当天）和部署检查用，她的工具不读它。

import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

export interface SessionEvent {
  type: string
  seq?: number
  time?: string
  data?: unknown
  [k: string]: unknown
}

export interface SessionLog {
  events: SessionEvent[]
  /** 成功解开的帧数（未压缩文件为 0） */
  frames: number
  /** 末尾解不开的残帧（写到一半时可能出现） */
  partial: number
  /** 解析失败的行数 */
  bad: number
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 把多帧 zstd 拼接的数据逐帧解开。魔数可能恰好出现在压缩数据里：某段解不开就和下一段合并再试。 */
export function decodeZstdFrames(buf: Buffer): { text: string; frames: number; partial: number } {
  const decompress = (zlib as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync
  if (!decompress) throw new Error('当前 Node 不支持 zstd（需要 22.15 及以上）')
  const starts: number[] = []
  for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 1)) starts.push(i)
  starts.push(buf.length)
  let text = ''
  let frames = 0
  let partial = 0
  let from = starts[0]!
  for (let k = 1; k < starts.length; k++) {
    // 注意：Node 对截断的帧不报错，而是返回空结果。DSH 每帧至少一个事件，所以空结果也算没解开
    let out: Buffer | undefined
    try {
      out = decompress(buf.subarray(from, starts[k]))
    } catch {
      out = undefined
    }
    if (out && out.length > 0) {
      text += out.toString('utf8')
      frames++
      from = starts[k]!
    } else if (k === starts.length - 1) {
      partial++
    }
  }
  return { text, frames, partial }
}

export function parseSessionLog(buf: Buffer): SessionLog {
  const zst = buf.subarray(0, 4).equals(MAGIC)
  const { text, frames, partial } = zst ? decodeZstdFrames(buf) : { text: buf.toString('utf8'), frames: 0, partial: 0 }
  const events: SessionEvent[] = []
  let bad = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line) as SessionEvent
      if (ev && typeof ev.type === 'string') events.push(ev)
      else bad++
    } catch {
      bad++
    }
  }
  return { events, frames, partial, bad }
}

export function readSessionLog(path: string): SessionLog {
  return parseSessionLog(readFileSync(path))
}

/** 系统注入的 user/message 来源；夜间回顾时剔除 */
export const INJECTED_SOURCES = ['time-context', 'runtime-context'] as const

export function sourceKind(ev: SessionEvent): string | undefined {
  const d = ev.data as { source?: { kind?: unknown } } | undefined
  return typeof d?.source?.kind === 'string' ? d.source.kind : undefined
}

/** 真人说的话（user/message 且不是系统注入） */
export function isPersonMessage(ev: SessionEvent): boolean {
  if (ev.type !== 'user/message') return false
  const k = sourceKind(ev)
  return k !== undefined && !(INJECTED_SOURCES as readonly string[]).includes(k)
}

/** 最后一次真正发给模型的工具名单（request/header 里的 header.tools）；没有请求过返回 undefined */
export function lastRequestTools(log: SessionLog, afterSeq = -1): string[] | undefined {
  for (let i = log.events.length - 1; i >= 0; i--) {
    const ev = log.events[i]!
    if (ev.type !== 'request/header' || (ev.seq ?? -1) <= afterSeq) continue
    const tools = (ev.data as { header?: { tools?: Array<{ name?: unknown }> } } | undefined)?.header?.tools ?? []
    return tools.map((t) => String(t.name))
  }
  return undefined
}

/**
 * 最后一条非空 system/message 的全文。
 * DSH 每次提交的都是渲染后的完整系统提示（agent-loop systemPrompt.project）：in-history 模式追加一条新的，
 * 否则用“替换”事件改写开头那条；清空旧条目的替换事件内容为空，跳过。
 */
export function lastSystemPrompt(log: SessionLog, afterSeq = -1): string | undefined {
  for (let i = log.events.length - 1; i >= 0; i--) {
    const ev = log.events[i]!
    if (ev.type !== 'system/message' || (ev.seq ?? -1) <= afterSeq) continue
    const content = (ev.data as { message?: { content?: unknown } } | undefined)?.message?.content
    const text = Array.isArray(content)
      ? content.map((b) => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join('')
      : typeof content === 'string' ? content : ''
    if (text) return text
  }
  return undefined
}

export function maxSeq(log: SessionLog): number {
  return log.events.reduce((m, e) => Math.max(m, e.seq ?? -1), -1)
}
