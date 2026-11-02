// DSH 宿主接口里我们用到的那一小部分（以 0.2.1-rc.2 源码为准）。
// 只声明用到的形状，不依赖任何 @deepseek-ai 包，便于单测时用假宿主替换。

export type Dispose = () => void

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute(args: unknown): Promise<unknown>
}

export interface ToolExec {
  name: string
}

export interface HostCtx {
  effect(fn: () => Dispose | void, label?: string): void
  /**
   * cordis 事件（记忆 v2 读侧用两种，以 0.2.1-rc.2 源码为准）：
   *   'agent/pre-step'（waterfall：(payload, next) => decision，可改写进入本步的消息；dsh-agent runtime-types.d.ts:293-310）
   *   'session/event'（(session, event) => void，提交后的事件流；dsh-session types/index.d.ts:61）
   * 可选：单测的假宿主、旧宿主可以没有，没有时 J / K 不生效。
   */
  on?(name: string, handler: (...args: never[]) => unknown, options?: { prepend?: boolean }): Dispose | void
  systemPrompt: {
    variable(name: string, provider: () => string): Dispose | void
  }
  tools: {
    register(def: ToolDef): Dispose | void
    schemas(): Array<{ name: string }>
    restrict(opts: { deny: string[] }): Dispose | void
    guard(fn: (exec: ToolExec) => string | undefined): Dispose | void
  }
}
