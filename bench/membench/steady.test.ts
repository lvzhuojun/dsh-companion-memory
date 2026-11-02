// 断线保护：网络错误重试、连不上就停、额度用完直接停、别的错误照常抛
import { describe, expect, it } from 'vitest'
import type { ModelClient } from '../p0/run.js'
import { steady } from './steady.js'

const reply = { content: [{ type: 'text', text: 'ok' }], usage: {} } as never
const req = { system: '', messages: [] } as never
const flaky = (errors: Error[]): ModelClient => ({
  async complete() {
    const e = errors.shift()
    if (e) throw e
    return reply
  },
})
const opts = (stops: string[]) => ({ waits: [1, 1], sleep: async () => {}, log: () => {}, fatal: (why: string): never => { stops.push(why); throw new Error('stopped') } })

describe('断线保护', () => {
  it('连接被重置：重试后成功', async () => {
    const stops: string[] = []
    const m = steady(flaky([new TypeError('fetch failed'), new Error('模型请求失败：HTTP 502')]), opts(stops))
    expect(await m.complete(req)).toBe(reply)
    expect(stops).toEqual([])
  })

  it('一直连不上：停下，不返回空回答', async () => {
    const stops: string[] = []
    const m = steady(flaky([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]), opts(stops))
    await expect(m.complete(req)).rejects.toThrow('stopped')
    expect(stops[0]).toContain('连不上网关')
  })

  it('额度用完：不重试，直接停', async () => {
    const stops: string[] = []
    const m = steady(flaky([new Error('模型请求失败：HTTP 429 rate_limit_error')]), opts(stops))
    await expect(m.complete(req)).rejects.toThrow('stopped')
    expect(stops[0]).toContain('额度')
  })

  it('别的错误（比如 400）：照常抛给调用方', async () => {
    const stops: string[] = []
    const m = steady(flaky([new Error('模型请求失败：HTTP 400 invalid_request_error')]), opts(stops))
    await expect(m.complete(req)).rejects.toThrow('HTTP 400')
    expect(stops).toEqual([])
  })
})
