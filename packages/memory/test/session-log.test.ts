import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { isPersonMessage, lastRequestTools, lastSystemPrompt, maxSeq, parseSessionLog, type SessionEvent } from '../src/session-log.js'

const zstd = (s: string) => zlib.zstdCompressSync(Buffer.from(s))
const lines = (evs: SessionEvent[]) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n'
const sys = (seq: number, text: string): SessionEvent => ({ type: 'system/message', seq, data: { message: { role: 'system', content: text ? [{ type: 'text', text }] : [] } } })
const header = (seq: number, tools: string[]): SessionEvent => ({ type: 'request/header', seq, data: { header: { tools: tools.map((name) => ({ name })) } } })
const user = (seq: number, kind: string): SessionEvent => ({ type: 'user/message', seq, data: { role: 'user', content: [], source: { kind } } })

describe('会话日志（多帧 zstd）', () => {
  it('逐帧解开，不只读第一个帧', () => {
    const a = lines([{ type: 'session', seq: 1 }, sys(2, '旧提示')])
    const b = lines([header(3, ['write_diary']), user(4, 'plugin:dsh-qq-bridge')])
    const c = lines([sys(5, '新提示 # 我怎么记事'), header(6, ['write_diary', 'recall_diary'])])
    const log = parseSessionLog(Buffer.concat([zstd(a), zstd(b), zstd(c)]))
    expect(log).toMatchObject({ frames: 3, partial: 0, bad: 0 })
    expect(log.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(maxSeq(log)).toBe(6)
  })

  it('末尾写到一半的帧记为残帧，前面的照常可读', () => {
    const whole = zstd(lines([{ type: 'session', seq: 1 }]))
    const cut = zstd(lines([{ type: 'turn/start', seq: 2 }])).subarray(0, 8)
    const log = parseSessionLog(Buffer.concat([whole, cut]))
    expect(log).toMatchObject({ frames: 1, partial: 1 })
    expect(log.events).toHaveLength(1)
  })

  it('未压缩的 jsonl 也能读', () => {
    expect(parseSessionLog(Buffer.from(lines([{ type: 'session', seq: 1 }]) + '坏行\n'))).toMatchObject({ frames: 0, bad: 1 })
  })

  it('取最后一次请求的工具名单与最后一份非空系统提示；可只看某个 seq 之后', () => {
    const log = parseSessionLog(Buffer.from(lines([sys(1, '旧'), header(2, ['a']), sys(3, '新'), sys(4, ''), header(5, ['a', 'recall_diary'])])))
    expect(lastRequestTools(log)).toEqual(['a', 'recall_diary'])
    expect(lastSystemPrompt(log)).toBe('新')
    expect(lastRequestTools(log, 5)).toBeUndefined()
    expect(lastSystemPrompt(log, 3)).toBeUndefined()
  })

  it('夜间回顾只看真人说的话：剔除 time-context / runtime-context', () => {
    const evs = [user(1, 'user'), user(2, 'plugin:dsh-qq-bridge'), user(3, 'time-context'), user(4, 'runtime-context'), sys(5, 'x')]
    expect(evs.filter(isPersonMessage).map((e) => e.seq)).toEqual([1, 2])
  })
})
