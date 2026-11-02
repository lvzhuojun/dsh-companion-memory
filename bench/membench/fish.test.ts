// 鱼的记忆适配器冒烟（不调真模型）：它自己的代码真的写进库、答题时真的注入；带线上 QQ 桥来源时 1.4.4 一条都不注入
import { describe, expect, it } from 'vitest'
import type { ModelClient } from '../p0/run.js'
import { fishMemory } from './fish.js'
import type { Transcript } from './transcript.js'

/** 假模型：读到“生日”那句就调 remember；其余时候只回一句话。把每次收到的系统提示和消息记下来 */
function fakeModel(seen: string[]): ModelClient {
  let n = 0
  return {
    async complete(req) {
      const last = req.messages[req.messages.length - 1]!
      const text = (last.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? '').join('\n')
      seen.push(text)
      const usage = { input_tokens: 10, output_tokens: 5 }
      if (req.tools.some((t) => t.name === 'remember') && /生日/.test(text) && last.role === 'user' && !text.includes('tool_result')) {
        return { content: [{ type: 'tool_use', id: `t${++n}`, name: 'remember', input: { text: 'ta 的生日是 1月27日', importance: 1, 事实键: 'ta.生日' } }], usage } as never
      }
      return { content: [{ type: 'text', text: '嗯嗯' }], usage } as never
    },
  }
}

const t = (): Transcript => ({ version: 'fish-smoke', ownerName: '老大', now: '2026-09-02T09:00:00+08:00', sessions: [], questions: [] })
const session = { date: '2026-09-01', time: '19:00', turns: [{ who: 'owner' as const, text: '跟你说，我生日是1月27日' }, { who: 'me' as const, text: '记住啦' }] }

describe('鱼的记忆适配器', () => {
  it('它自己的 remember 写进库；第二天问生日，注入里有这条', async () => {
    const seen: string[] = []
    const sys = fishMemory({ t: t(), model: fakeModel(seen) })
    await sys.ingest(session)
    expect(sys.has!(['1月27日'])).toBe(true)
    await sys.answer('我生日是哪天？')
    expect(seen[seen.length - 1]).toContain('【你记得的事】')
    expect(seen[seen.length - 1]).toContain('1月27日')
    expect(sys.stats!().remembered).toBe(1)
    sys.close()
  }, 30000)

  it('消息带线上 QQ 桥来源（plugin:dsh-qq-bridge）：写得进去，但 1.4.4 一条都不注入', async () => {
    const seen: string[] = []
    const sys = fishMemory({ t: t(), model: fakeModel(seen) }, { qqSource: true })
    await sys.ingest(session)
    expect(sys.has!(['1月27日'])).toBe(true)
    await sys.answer('我生日是哪天？')
    expect(seen[seen.length - 1]).not.toContain('【你记得的事】')
    sys.close()
  }, 30000)
})
