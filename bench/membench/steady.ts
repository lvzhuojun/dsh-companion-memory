// 断线保护：长时间评测中途断网时，不能把之后每道题的空回答都记成“答错”、夜间整理也全失败。
// 网络类错误（连不上 / 连接被重置 / 上游 502–504）退避重试；还不行就整次停下（退出码 3），宁可没结果也不出假结果。
// 额度用完（402 / 429）不重试，直接停。
import type { ModelClient } from '../p0/run.js'

const NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|terminated|other side closed|UND_ERR|HTTP 50[234]/i
const BUDGET = /HTTP (402|429)/

export interface SteadyOptions {
  /** 每次重试前等几毫秒（默认 5 s、15 s、45 s、2 min、4 min） */
  waits?: number[]
  /** 连不上时怎么停（默认打印原因后退出进程，退出码 3） */
  fatal?: (why: string) => never
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
}

const exit = (why: string): never => {
  console.error(`\n✗ 评测停下：${why}。这次的结果不完整、不要用；查好连接后重跑。`)
  process.exit(3)
}

export function steady(m: ModelClient, o: SteadyOptions = {}): ModelClient {
  const waits = o.waits ?? [5_000, 15_000, 45_000, 120_000, 240_000]
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const fatal = o.fatal ?? exit
  const log = o.log ?? ((l: string) => console.error(l))
  return {
    async complete(req) {
      for (let i = 0; ; i++) {
        try {
          return await m.complete(req)
        } catch (e) {
          const msg = e instanceof Error ? `${e.message} ${(e as { cause?: { code?: string; message?: string } }).cause?.code ?? ''}` : String(e)
          if (BUDGET.test(msg)) return fatal(`网关额度用完（${msg.trim()}）`)
          if (!NETWORK.test(msg)) throw e
          if (i >= waits.length) return fatal(`连不上网关，重试 ${waits.length} 次仍失败（${msg.trim()}）`)
          log(`  （连接出错：${msg.trim()}；${Math.round(waits[i]! / 1000)} 秒后重试第 ${i + 1} 次）`)
          await sleep(waits[i]!)
        }
      }
    },
  }
}
