import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCompactionDeps, looksRight, makeCompanionEngine, ZH_COMPACTION_INSTRUCTION, type CompactionDeps } from '../src/compaction.js'

// 假的 compaction-basic：和 rc.2 的形状一致（构造参数 (ctx, config)、config 已解析、summarize/compactIfNeeded 在原型上）
class FakeEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']
  static Config = () => {}
  ctx: { llm: { stream(o: Record<string, unknown>): AsyncIterable<unknown> } }
  config: { summarizationProvider: string; summarizationModel: string; maxTokens: number }
  constructor(ctx: FakeEngine['ctx'], config: Partial<FakeEngine['config']> = {}) {
    this.ctx = ctx
    this.config = { summarizationProvider: '', summarizationModel: '', maxTokens: 65536, ...config }
  }
  async summarize() { return { summary: [{ type: 'text', text: 'English checkpoint' }] } }
  async compactIfNeeded() { return null }
}
class FakeAssembler {
  chunks: Array<{ type: string; text?: string }> = []
  finish: { kind: string; failure?: { message: string; code?: string } } = { kind: 'stop' }
  usage = { inputTokens: 10 }
  push(c: unknown) {
    const x = c as { finish?: FakeAssembler['finish']; block?: { type: string; text?: string } }
    if (x.finish) this.finish = x.finish
    if (x.block) this.chunks.push(x.block)
  }
  blocks() { return this.chunks }
}
const deps: CompactionDeps = { Engine: FakeEngine, BlockAssembler: FakeAssembler, via: 'test' }

function setup(chunks: unknown[], config: Partial<FakeEngine['config']> = {}) {
  const calls: Array<Record<string, unknown>> = []
  const ctx = { llm: { async *stream(o: Record<string, unknown>) { calls.push(o); for (const c of chunks) yield c } } }
  const Engine = makeCompanionEngine(deps) as unknown as new (ctx: unknown, config: unknown) => { summarize(i: unknown, a: unknown): Promise<Record<string, unknown>> }
  const agent = {
    options: { provider: 'p-agent', model: 'm-agent' },
    session: { id: 's1', requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }), toolHistory: () => ['th'] },
  }
  return { engine: new Engine(ctx, config), calls, agent }
}

describe('中文陪伴版压缩', () => {
  it('子类继承 compaction-basic 的静态配置与注入；只重写 summarize', () => {
    const E = makeCompanionEngine(deps) as unknown as typeof FakeEngine
    expect(E.inject).toEqual(['llm', 'tokenMeter', 'sessions'])
    expect(E.Config).toBe(FakeEngine.Config)
    expect(E.prototype.compactIfNeeded).toBe(FakeEngine.prototype.compactIfNeeded)
    expect(E.prototype.summarize).not.toBe(FakeEngine.prototype.summarize)
  })

  it('复用会话前缀，把中文指令作为最后一条 user 消息追加；目标模型取最近一次请求；purpose=compaction', async () => {
    const { engine, calls, agent } = setup([{ block: { type: 'thinking' } }, { block: { type: 'text', text: '## 刚才都发生了什么\n老大下班了' } }])
    const r = await engine.summarize({ messages: [{ role: 'system' }, { role: 'user' }], tools: [{ name: 't' }] }, agent)
    const o = calls[0]!
    expect(o).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash', purpose: 'compaction', sessionId: 's1', maxTokens: 65536, tools: [{ name: 't' }], toolHistory: ['th'] })
    const msgs = o.messages as Array<{ role: string; content?: Array<{ text: string }> }>
    expect(msgs).toHaveLength(3)
    expect(msgs[2]).toEqual({ role: 'user', content: [{ type: 'text', text: ZH_COMPACTION_INSTRUCTION }] })
    expect(r).toMatchObject({ llmStreamCall: true, provider: 'deepseek-official', summary: [{ type: 'text', text: '## 刚才都发生了什么\n老大下班了' }], usage: { inputTokens: 10 } })
  })

  it('翻篇时记一行只有数字的日志（不含摘要内容）', async () => {
    const logs: string[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => void logs.push(a.join(' '))
    try {
      const { engine, agent } = setup([{ block: { type: 'text', text: '老大下班了，我们聊了晚饭' } }])
      await engine.summarize({ messages: [{ role: 'system' }, { role: 'user' }, { role: 'assistant' }] }, agent)
    } finally { console.error = orig }
    expect(logs).toEqual(['[her-compaction] 翻篇：3 条消息 → 中文摘要 12 字'])
  })

  it('配置了摘要模型时用配置的', async () => {
    const { engine, calls, agent } = setup([{ block: { type: 'text', text: 'x' } }], { summarizationProvider: 'p2', summarizationModel: 'm2' })
    await engine.summarize({ messages: [] }, agent)
    expect(calls[0]).toMatchObject({ provider: 'p2', model: 'm2' })
  })

  it('出错、被截断、没有文字时都失败关闭（和默认实现一致，不写残缺的检查点）', async () => {
    const a = setup([{ finish: { kind: 'error', failure: { message: 'boom', code: 'X' } } }])
    await expect(a.engine.summarize({ messages: [] }, a.agent)).rejects.toThrow('boom')
    const b = setup([{ block: { type: 'text', text: '半截' } }, { finish: { kind: 'max-tokens' } }])
    await expect(b.engine.summarize({ messages: [] }, b.agent)).rejects.toThrow(/truncated/)
    const c = setup([{ block: { type: 'text', text: '  ' } }])
    await expect(c.engine.summarize({ messages: [] }, c.agent)).rejects.toThrow(/no text/)
  })

  it('指令：中文、第一人称、五节结构、不复述日记和记忆原文、不超过 1500 字', () => {
    for (const s of ['## 刚才都发生了什么', '## 我们之间', '## 对方现在怎么样', '## 我自己', '## 没说完的', '不要编', '不抄内容', '1500 字', '<compacted-summary>'])
      expect(ZH_COMPACTION_INSTRUCTION).toContain(s)
  })
})

describe('分层加载（F-7）', () => {
  const good = { BasicCompactionEngine: FakeEngine }
  const llm = { BlockAssembler: FakeAssembler }

  it('第 1 层 import 成功就用它', async () => {
    const d = await loadCompactionDeps({ importer: async (s) => (s.includes('compaction') ? good : llm), anchors: [] })
    expect(d?.via).toBe('peer')
  })

  it('第 1 层失败 → 以 DSH 安装为锚点解析（第 2 层），拿到的是锚点下那一份文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-dsh-'))
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"@deepseek-ai/dsh"}')
      for (const n of ['dsh-compaction-basic', 'dsh-llm']) {
        const p = join(dir, 'node_modules', '@deepseek-ai', n)
        mkdirSync(p, { recursive: true })
        writeFileSync(join(p, 'package.json'), '{"main":"index.js"}')
        writeFileSync(join(p, 'index.js'), '')
      }
      const seen: string[] = []
      const importer = async (s: string) => {
        seen.push(s)
        if (!s.startsWith('file:')) throw Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' })
        return s.includes('dsh-compaction-basic') ? good : llm
      }
      const d = await loadCompactionDeps({ importer, anchors: [join(dir, 'package.json')] })
      expect(d?.via).toBe('dsh-install')
      expect(seen.filter((s) => s.startsWith('file:')).every((s) => s.includes('fake-dsh-'))).toBe(true)
      expect(await loadCompactionDeps({ importer, anchors: [] })).toBeNull() // 没有锚点 → 第 3 层
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('拿到的类不像预期 → 不接管（第 3 层）', async () => {
    const d = await loadCompactionDeps({ importer: async (s) => (s.includes('compaction') ? { BasicCompactionEngine: class {} } : llm), anchors: [] })
    expect(d).toBeNull()
    expect(looksRight(good, llm)).toBe(true)
    expect(looksRight({ BasicCompactionEngine: FakeEngine }, {})).toBe(false)
  })
})
