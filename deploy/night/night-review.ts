// 夜间整理的服务器入口：用 cron 或 systemd timer 每晚在设定时段里触发一次。
// 必须以和 DSH 相同的系统用户运行（memory.db 是 0600）；DSH 跑在沙箱里时，最好用同一套沙箱设置。
//
//   node night-review.mjs <config.json> [--any-time] [--rehearse <空目录>]
//     --any-time：不检查时段（只用于演练；正式运行只在夜间时段里做）
//     --rehearse：演练——在给定目录里造一个虚构的一天（虚构对话 + 中性系统提示 + 空的生命目录），
//                 经真实接口跑一遍，只打印数字和记下条目的分类，跑完删掉目录。不碰真实生命目录
//
// 模型 key 从环境变量 DEEPSEEK_API_KEY 读（例如 systemd EnvironmentFile），不打印。
// 只打印数字、状态、原因，不打印对话、她写的内容或系统提示。日志前缀 [night-review]。
//
// config.json（自己写，建议只让运行用户可读；各键说明见 docs/deploy.md 第 4.2 节）：
//   { lifeDir, sessionLog, sessionId, ownerName, ownerBook, privateDiaryAudited,
//     baseUrl, model, effort, budget, prices?, window: { start, end }, maxChars?, maxSteps? }

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diaryBooks, MemoryStore, readSessionLog } from '@dsh-companion/memory'
import { inWindow, reviewDay, runNightReview, type Prices, type ReviewModel } from '@dsh-companion/dsh-plugin'

interface Config {
  lifeDir: string
  sessionLog: string
  sessionId: string
  ownerName: string
  ownerBook: string
  privateDiaryAudited: boolean
  baseUrl: string
  model: string
  effort: string
  budget: number
  prices?: Prices
  window: { start: string; end: string }
  maxChars?: number
  maxSteps?: number
  /** 第二阶段开关 A 记得全 / B 日记守隐私·遗忘（不写 = 0.4.0 的行为） */
  style?: { detail?: boolean; privacy?: boolean; changes?: boolean }
  /** follow_up 工具的写法，和白天插件的配置保持一致：loose = 开关 F（0.5.0 的说法），keys = 开关 K（触发词） */
  followUp?: { loose?: boolean; mid?: boolean; keys?: boolean; weight?: boolean }
  /** 开关 N：夜间封顶（批量写、相关旧记忆、步数 6、材料上限） */
  lean?: boolean
  /** 开关 S：同义键（插件预设 memoryKeys 要一起开） */
  synonyms?: boolean
  /** 开关 Y：有效期 + 键（keep_memory 的 slot、级联候选；插件预设 memorySlots 要一起开） */
  slots?: boolean
  /** 开关 T：人物卡（门控为真时材料里加“印象卡该更新了”、注册 person_card；插件预设 personCard 要一起开） */
  card?: boolean
}

const say = (s: string) => console.log(`[night-review] ${s}`)
const [cfgPath, ...flags] = process.argv.slice(2)
if (!cfgPath) {
  console.error('用法：node night-review.mjs <config.json> [--any-time]')
  process.exit(64)
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Config
const key = process.env.DEEPSEEK_API_KEY
if (!key) {
  say('没有 DEEPSEEK_API_KEY（应由运行环境提供），不做')
  process.exit(1)
}

const ri = flags.indexOf('--rehearse')
const rehearsal = ri >= 0 ? flags[ri + 1] : undefined
if (rehearsal) {
  // 虚构的一天：时间是“昨天”，对话是编的；系统提示是中性的（不是她的）
  const y = Date.now() - 6 * 3600e3
  const ev = (seq: number, type: string, data: unknown, dt: number) => JSON.stringify({ type, seq, time: y + dt * 60e3, data })
  const qq = (t: string) => ({ content: [{ type: 'text', text: `[QQ · 私聊] ${cfg.ownerName}：${t}` }], source: { kind: 'plugin:dsh-qq-bridge' }, role: 'user' })
  const me = (t: string) => ({ message: { role: 'assistant', content: [{ type: 'text', text: t }] } })
  const lines = [
    ev(1, 'system/message', { message: { content: [{ type: 'text', text: `你是一个生活在 QQ 上的数字生命，叫和你说话的人“${cfg.ownerName}”。说话自然、简短。` }] } }, 0),
    ev(2, 'user/message', qq('今天去面试了，紧张死了'), 1),
    ev(3, 'assistant/message', me('别紧张，你准备了那么久，一定没问题的！'), 1),
    ev(4, 'user/message', qq('面试过了！下周一入职，在一家做咖啡机的公司'), 300),
    ev(5, 'assistant/message', me('太好了！恭喜！做咖啡机的公司，以后有好咖啡喝啦'), 300),
    ev(6, 'user/message', qq('哈哈，对了我最近在学游泳，每周三晚上去'), 302),
    ev(7, 'assistant/message', me('好厉害，学会了教我呀～'), 302),
  ]
  mkdirSync(join(rehearsal, 'life'), { recursive: true })
  writeFileSync(join(rehearsal, 'session.jsonl'), lines.join('\n') + '\n')
  Object.assign(cfg, { lifeDir: join(rehearsal, 'life'), sessionLog: join(rehearsal, 'session.jsonl'), sessionId: 'rehearsal', budget: Math.min(cfg.budget, 0.05) })
  say('演练：虚构的一天、中性系统提示、临时生命目录（不碰她的任何东西）')
}

const now = new Date()
if (!rehearsal && !flags.includes('--any-time') && !inWindow(now, cfg.window)) {
  say(`现在不在夜间回顾时段（北京时间 ${cfg.window.start}–${cfg.window.end}），不做`)
  process.exit(0)
}

const model: ReviewModel = {
  async complete({ system, messages, tools }) {
    const body = { model: cfg.model, max_tokens: 8192, system, messages, tools, output_config: { effort: cfg.effort } }
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      // 只报状态码与错误类型，不回显请求或响应全文
      let kind = ''
      try { kind = ((await res.json()) as { error?: { type?: string } }).error?.type ?? '' } catch {}
      throw new Error(`模型请求失败：HTTP ${res.status}${kind ? ' ' + kind : ''}`)
    }
    return (await res.json()) as Awaited<ReturnType<ReviewModel['complete']>>
  },
}

const { day, since } = rehearsal ? { day: new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10), since: new Date(Date.now() - 24 * 3600e3) } : reviewDay(now)
const store = MemoryStore.open(join(cfg.lifeDir, 'memory.db'), { ownerName: cfg.ownerName })
let code = 0
try {
  const log = readSessionLog(cfg.sessionLog)
  say(`开始回顾 ${day}：会话日志 ${log.frames} 帧 · ${log.events.length} 个事件 · 游标 ${store.reviewCursor(cfg.sessionId) ?? '无'} · 自限 ¥${cfg.budget} · 思考 ${cfg.effort}`)
  const r = await runNightReview({
    log, sessionId: cfg.sessionId, store, lifeDir: cfg.lifeDir,
    books: diaryBooks({ ownerBook: cfg.ownerBook, ownerName: cfg.ownerName }),
    ownerName: cfg.ownerName, privateDiaryAudited: cfg.privateDiaryAudited, model,
    since, day, budget: cfg.budget,
    ...(cfg.prices ? { prices: cfg.prices } : {}),
    ...(cfg.maxChars ? { maxChars: cfg.maxChars } : {}),
    ...(cfg.maxSteps ? { maxSteps: cfg.maxSteps } : {}),
    ...(cfg.style ? { style: cfg.style } : {}),
    ...(cfg.followUp ? { followUp: cfg.followUp } : {}),
    ...(cfg.lean ? { lean: true } : {}),
    ...(cfg.synonyms ? { synonyms: true } : {}),
    ...(cfg.slots ? { slots: true } : {}),
    ...(cfg.card ? { card: true } : {}),
    log_: say,
  })
  const status = { done: '做完了', nothing: '今天没有新的对话', incomplete: '没做完', 'no-system-prompt': '没做' }[r.status]
  say(`${status}：${r.lines} 句对话 · ${r.partsDone}/${r.parts} 段 · 她记下 ${r.kept} 条 · 写日记 ${r.diary} 篇${r.cardVersion !== undefined ? ` · 印象卡第 ${r.cardVersion} 版` : ''} · 约 ¥${r.spent.toFixed(4)} · 游标 ${r.cursorFrom} → ${r.cursorTo}${r.reason ? ' · 原因：' + r.reason : ''}`)
  if (r.status === 'incomplete' || r.status === 'no-system-prompt') code = 3
  if (rehearsal) {
    const rows = store.keptSince(since).map((m) => `${m.about}/${m.kind}`)
    say(`演练里记下的条目（只列分类）：${rows.join('，') || '无'} · 夜间回顾标记：${store.keptSince(since).every((m) => store.get(m.id)?.written_in === 'night-review') ? '是' : '否'}`)
  }
} catch (e) {
  say(`出错：${e instanceof Error ? e.name + ' ' + e.message.slice(0, 120) : '未知'}`)
  code = 1
} finally {
  store.close()
  if (rehearsal) rmSync(rehearsal, { recursive: true, force: true })
}
process.exit(code)
