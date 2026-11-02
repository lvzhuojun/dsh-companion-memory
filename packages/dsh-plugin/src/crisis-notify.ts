// 危机通知紧急联系人：代码直接发 QQ 私信，不经过她（模型）。
//
// 通道（依据 DSH 0.2.1-rc.2 与 dsh-qq-bridge 0.1.3 源码）：
//   · ctx.tools.execute({ callId, name, arguments, signal })——dsh-tools lib/types/index.d.ts:766 公开方法，
//     走完整管线（tools/pre-execute → 守卫 → 工具本体 → post-execute）。不带 agent 时按全局视图查工具、只过全局守卫
//     （index.js:3024 guardReason、3212 execute）；会话预设里的 restrict / guard 挂在会话作用域，不拦这条。
//     审批类前置（auto-review、workspace-changes）都是 exec.agent 为空就放行。部署默认 mode = native，不受 ptc 收拢影响。
//   · qq_bridge_send（dsh-qq-bridge index.js:2312）：参数 { text, userId?, groupId? }；返回 JSON 字符串
//     { sent, dropped, reason?, destination? }。出站不查白名单（sendToQQ index.js:1715），超字数整条不发（too-long）。
//     来源闸门 outboundGate（index.js:2296）：本轮是 QQ 唤醒的直接放行；网页里发起的一轮第一次只回 needsConfirm、
//     同一轮再调一次才真发——所以收到 needsConfirm 时再调一次（这是代码发的告警，不是她在乱发）。
// 号码只在私有预设里（emergencyContact）；本文件的日志、报错里一律不出现号码（长数字打码）。

import type { CrisisNotify } from '@dsh-companion/memory'

export const QQ_SEND_TOOL = 'qq_bridge_send'

interface ExecResult {
  isError?: boolean
  value?: unknown
  error?: { message?: string }
  content?: Array<{ type?: string; text?: string }>
}

/** 宿主工具运行时里我们用到的部分（HostCtx.tools 上不一定有 execute：旧宿主 / 单测假宿主） */
export interface ToolRuntimeLike {
  execute?: (exec: { callId: string; name: string; arguments: unknown; signal: AbortSignal }) => Promise<ExecResult>
  get?: (name: string) => unknown
  schemas?: () => Array<{ name: string }>
}

export interface CrisisNotifier {
  /** 启动时能确定的状态：可用 / 不可用（原因） */
  readonly available: boolean
  readonly reason: string
  /** 发一条；成功 true，失败 false（失败原因已写日志） */
  send(n: CrisisNotify): Promise<boolean>
}

/** 日志里的长数字一律打码（QQ 号、群号） */
export const redact = (s: string) => s.replace(/\d{5,}/g, '＊＊＊')

function parseValue(r: ExecResult): Record<string, unknown> | undefined {
  const raw = r.value ?? r.content?.find((c) => c?.type === 'text')?.text
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return undefined
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function makeCrisisNotifier(tools: ToolRuntimeLike | undefined, contact: string | undefined, log: (...a: unknown[]) => void, o: { timeoutMs?: number } = {}): CrisisNotifier {
  const to = typeof contact === 'string' ? contact.trim() : ''
  let reason = ''
  if (!to) reason = '没有配置 emergencyContact'
  else if (!/^\d{5,12}$/.test(to)) reason = 'emergencyContact 不是 QQ 号的格式'
  else if (!tools || typeof tools.execute !== 'function') reason = '宿主没有 ctx.tools.execute'
  const available = !reason

  const fail = (why: string) => {
    log(`【紧急】未能发出：${redact(why)}`)
    return false
  }

  return {
    available,
    reason: available ? `${QQ_SEND_TOOL}（私信）` : reason,
    async send(n: CrisisNotify): Promise<boolean> {
      if (!available) return fail(reason)
      const call = async (i: number) => tools!.execute!({
        callId: `her-life-crisis-${Date.now()}-${i}`,
        name: QQ_SEND_TOOL,
        arguments: { text: n.text, userId: to },
        signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      })
      try {
        let r = await call(0)
        let v = r.isError ? undefined : parseValue(r)
        // 网页里发起的一轮：桥第一次只回“确认要发吗”，同一轮再调一次才发
        if (v?.needsConfirm === true) {
          r = await call(1)
          v = r.isError ? undefined : parseValue(r)
        }
        if (r.isError) return fail(r.error?.message ?? r.content?.map((c) => c.text ?? '').join(' ') ?? '工具报错')
        if (!v) return fail('看不懂工具的返回')
        if (typeof v.error === 'string') return fail(v.error)
        if (Number(v.sent) > 0) {
          log(`【紧急】已发给紧急联系人（等级 ${n.level}）`)
          return true
        }
        return fail(typeof v.reason === 'string' ? v.reason : '没有发出（sent = 0）')
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }
}
