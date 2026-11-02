import type { ToolDef } from './host.js'

export type ToolResult = { ok: boolean; message: string; [k: string]: unknown }

// 和 @deepseek-ai/dsh-tools 的 defineTool 产物同形（沿用 dsh-her-life 0.1.0 的写法）
export function tool(spec: {
  name: string
  description: string
  properties: Record<string, unknown>
  required: string[]
  execute: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>
}): ToolDef {
  return {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.properties, required: spec.required, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, v) => {
        const r = v as Partial<ToolResult> | undefined
        return [{ type: 'text', text: r && r.ok === false ? '✗ ' + (r.message || '没成功') : (r && r.message) || '✓' }]
      },
    },
    async execute(args) {
      try {
        const r = await spec.execute((args ?? {}) as Record<string, unknown>)
        return JSON.parse(JSON.stringify(r ?? { ok: true, message: '✓' }))
      } catch (e) {
        return { ok: false, message: String(e instanceof Error ? e.message : e) }
      }
    },
  }
}

/** 北京时间（她的作息按北京时间算） */
export function beijing(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000).toISOString()
  return { date: t.slice(0, 10), time: t.slice(11, 16), iso: t.slice(0, 19) + '+08:00' }
}
