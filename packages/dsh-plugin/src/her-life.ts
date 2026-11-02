// her-life —— 她的生命层（会话作用域，只在她的预设里挂载）。
// 包名 dsh-her-life；提供 {{<前缀>_memory}}、日记与记忆工具。
//
//   1. 提示词变量（前缀可配置，默认 companion）
//               {{<前缀>_seed}}（种子，root 所有、她只能读）
//               {{<前缀>_self}}（self.md）
//               {{<前缀>_memory}}（记忆规则 + 稳定层“我心里记得的”，每天 06:00 换一次）
//   2. 只属于她的工具（只读写她自己的目录，路径写死，不接受任何路径参数）：
//        write_diary          写日记：给主人的 / 只给自己的（只追加）
//        propose_self_change  提交对 self.md 的修改，必须附经历作为证据；进待审区，不直接生效
//        recall_diary         翻自己的日记（只读）
//        keep_memory          用自己的话记一条记忆（memory.db，正文不可改；P1）
//        recall_memory        翻自己的记忆（只读，只翻当前可见范围；P1）
//        follow_up            惦记过几天想问问的事，标问过了 / 有结果了 / 不用再问
//   3. 安全：工具屏蔽名单（restrict.deny）+ 执行前拦截（guard），双保险
//
// 称呼、日记本名、变量前缀都来自配置，代码里不写死任何实例。
// 路径默认值只是示例；实际部署在预设配置里显式给出 seedPath / lifeDir。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CrisisWatch, diaryBooks, MemoryStore, OWNER_ID, PREFIX_TIERS, stableLayerWithIds, type CrisisNotify, type GateThresholds, type PrefixTier } from '@dsh-companion/memory'
import { makeCrisisNotifier, type ToolRuntimeLike } from './crisis-notify.js'
import type { HostCtx } from './host.js'
import { followUpTool, keepMemoryTool, recallMemoryTool } from './memory-tools.js'
import { reviewDay } from './night-review.js'
import { compactionCounter, loadCreateUserMessage, makeNoticer, preStepHandler, type CreateUserMessage } from './read-side.js'
import { recallDiaryTool } from './recall-diary.js'
import { memoryRules } from './rules.js'
import { beijing, tool } from './tool.js'
import { writeDiaryTool } from './write-diary.js'

export interface HerLifeConfig {
  seedPath?: string
  lifeDir?: string
  blockTools?: string[]
  /** 主人的称呼，默认“主人” */
  ownerName?: string
  /** 给主人看的日记本 id，默认 to_owner */
  ownerBook?: string
  /** 提示词变量前缀，默认 companion */
  variablePrefix?: string
  /** 主人是否承诺只用留痕的方式看私人日记。没有这个承诺就保持 false，给她的说明不能说假话。默认 false */
  privateDiaryAudited?: boolean
  /** 记忆库模块（keep_memory / recall_memory，生命目录下的 memory.db）。默认开 */
  memory?: boolean
  /** 开关 C：问到“我的某某”而稳定层里没有时先翻再答（默认关） */
  askFirst?: boolean
  /** 开关 D：稳定层带日期、几岁 / 多久按日期算（默认关） */
  timeCalc?: boolean
  /** 记忆 v2 开关 J：每轮由代码按她这句话翻记忆，命中才追加“我想起来的”（默认关） */
  inject?: boolean
  /** 记忆 v2 开关 K：惦记的事到日子由代码提醒（“该问问了”），稳定层只说还惦记着几件（默认关） */
  followTrigger?: boolean
  /** 记忆 v2 开关 P：稳定层档位 P46（默认，= 0.5.1）/ P100 / P200 / Pall。不叫 prefix：预设里 persona 自己有 prefix 字段，部署脚本按字段名读预设，同名容易读混 */
  prefixTier?: PrefixTier
  /** 开关 J 的门控阈值（校准后写在预设里；不给用引擎默认） */
  injectGate?: Partial<GateThresholds>
  /** 开关 F：follow_up 用 0.5.0 的说法（去掉 0.5.1 那句收紧的话；见 memory-tools.ts FOLLOW_UP_STRICT_LINE）。夜间回顾的 config.json 里 followUp.loose 要一起开 */
  followUpLoose?: boolean
  /** 开关 M：follow_up 用折中的说法（FOLLOW_UP_MID_LINE；优先于 F）。夜间回顾的 config.json 里 followUp.mid 要一起开 */
  followUpMid?: boolean
  /** 记忆 v2 开关 R（取代 J）：问到以前的事时代码替她翻完、结果全给（“【我刚翻过】”）；规则 C′；工具一次给 8 条（默认关） */
  prerecall?: boolean
  /** 记忆 v2 开关 W：惦记分大事 / 小事、可以改日子；开 K 时“该问问了”每天合计最多 1 件、对方难受或在讲别的事时先不提（默认关）。夜间回顾的 followUp.weight 要一起开 */
  followUpWeight?: boolean
  /** 记忆 v2 开关 V：预翻结果后附实体核对（问的是自己、翻到的却是别人的事，或反过来）。要和 prerecall 一起开（默认关） */
  entityCheck?: boolean
  /** 记忆 v2 开关 S：keep_memory 多一个可选的同义键 keys（检索单独一列、降权）。夜间回顾的 synonyms 要一起开（默认关） */
  memoryKeys?: boolean
  /**
   * 记忆 0.7 开关 Y：有效期 + 键——keep_memory 多一个可选的 slot（会变的事是哪一件）；同一主人同一件事有了新的一条，
   * 旧的由代码标失效（不删、不改原文，翻得到、带有效期），稳定层只列还有效的。夜间回顾的 slots 要一起开（默认关）
   */
  memorySlots?: boolean
  /**
   * 记忆 0.7 开关 T：人物卡——有她夜里写的印象卡时，稳定层先放卡（她的原文），memorySlots 也开时再放“现在”
   * （当前有效的值型键，只带起始日期），其后才是条目（person 节最多 10 条）；没有卡时和不开一样。夜间回顾的 card 要一起开（默认关）
   */
  personCard?: boolean
  /**
   * 记忆 0.7 开关 Z：危机协议——每条真人消息先过词法分级；出现信号就在本轮最前面给她
   * 【现在要注意的】（判断 / 资源 / 禁区 / 时机，没有台词），谨慎期 max(48 小时, 40 轮)；等级 ≥ 3 等由代码直接私信紧急联系人。默认关
   */
  crisis?: boolean
  /** 危机通知发给谁（QQ 号）。只写在私有预设里；代码与日志里不出现号码 */
  emergencyContact?: string
  /** 她的名字（危机通知开头“【紧急】<名字>：”）；不给就不写 */
  selfName?: string
}

export const DEFAULTS = { ownerName: '主人', ownerBook: 'to_owner', variablePrefix: 'companion', privateDiaryAudited: false, memory: true } as const

export const OWN_TOOLS = ['write_diary', 'propose_self_change', 'recall_diary', 'keep_memory', 'recall_memory', 'follow_up'] as const
/** 记忆库模块的工具（memory 关掉时不注册） */
export const MEMORY_TOOLS = ['keep_memory', 'recall_memory', 'follow_up'] as const

/**
 * 稳定层的缓存：同一个“日子”（北京时间 06:00 换天，夜间回顾 00:40 做完之后）只生成一次。
 * 变量每个 step 都会求值，这里平时只做一次日期换算、返回缓存的字符串，不碰数据库；
 * 一天只变一次，前缀缓存一天只多一小段未命中。生成失败时退回只有规则，记日志，不让她的会话挂掉。
 */
export function dailyCache(make: () => string, dayOf: () => string, onError: (e: unknown) => void = () => {}): () => string {
  let day: string | undefined
  let text = ''
  return () => {
    const d = dayOf()
    if (d !== day) {
      day = d
      try {
        text = make()
      } catch (e) {
        text = ''
        onError(e)
      }
    }
    return text
  }
}

/**
 * 记忆 v2：稳定层的换代键 = 压缩代次 + 日子。
 * 前缀不大（≤ BIG_PREFIX_CHARS）时照旧每天换；大了就最多 3 天换一次，平时只随压缩换代——
 * DSH 对 DeepSeek 是 systemPromptUpdate: in-history，系统提示一变就整段追加进历史，前缀越大越不能天天变。
 */
export const BIG_PREFIX_CHARS = 14500
export function cacheKey(gen: number, day: string, lastChars: number): string {
  if (lastChars <= BIG_PREFIX_CHARS) return `${gen}:${day}`
  const idx = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000)
  return `${gen}:b${Math.floor(idx / 3)}`
}

function readText(path: string, fallback: string): string {
  try {
    return readFileSync(path, 'utf8').trim() || fallback
  } catch {
    return fallback
  }
}

function sha(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o700 })
}

export function applyHerLife(ctx: HostCtx, config: HerLifeConfig = {}) {
  const seedPath = config.seedPath ?? '/etc/companion/seed.md'
  const lifeDir = config.lifeDir ?? join(process.env.HOME ?? '.', 'life')
  const blocked = new Set(Array.isArray(config.blockTools) ? config.blockTools : ['qq_bridge_napcat'])
  const selfPath = join(lifeDir, 'self.md')
  const log = (...a: unknown[]) => console.error('[her-life]', ...a)

  const ownerName = config.ownerName ?? DEFAULTS.ownerName
  const audited = config.privateDiaryAudited ?? DEFAULTS.privateDiaryAudited
  const prefix = config.variablePrefix ?? DEFAULTS.variablePrefix
  if (!/^[a-z][a-z0-9]{0,15}$/.test(prefix)) {
    throw new Error(`variablePrefix 不合法：${JSON.stringify(prefix)}（小写字母开头，只含小写字母和数字）`)
  }
  // 配置先全部校验完，再打开记忆库（校验失败时不留下打开的库）
  if (config.prefixTier !== undefined && !(config.prefixTier in PREFIX_TIERS)) throw new Error(`prefixTier 只能是 ${Object.keys(PREFIX_TIERS).join(' / ')}`)
  const books = diaryBooks({ ownerBook: config.ownerBook ?? DEFAULTS.ownerBook, ownerName })
  const v = (name: string) => `${prefix}_${name}`
  for (const b of books.ids) ensureDir(join(lifeDir, 'diary', books.dir(b)))
  ensureDir(join(lifeDir, 'proposals'))

  // 记忆库（P1）：打不开时不让整个插件挂掉——退回“只有日记”的规则和工具，并记日志（不静默跳过）
  let store: MemoryStore | undefined
  let memInfo = '关'
  if (config.memory ?? DEFAULTS.memory) {
    try {
      store = MemoryStore.open(join(lifeDir, 'memory.db'), { ownerName })
      const iv = store.verifyIntegrity()
      memInfo = `v${store.version()} · ${iv.total} 条 · 正文校验 ${iv.mismatched.length === 0 ? '一致' : `${iv.mismatched.length} 条不一致`} · sqlite ${iv.sqlite} · 索引格式 ${store.indexFormat()}`
    } catch (e) {
      store = undefined
      memInfo = `已开启但打不开，本次没有生效（${e instanceof Error ? e.message : String(e)}）`
      log('记忆库打不开，退回只有日记：', e instanceof Error ? e.message : e)
    }
  }
  const v2 = { inject: !!store && !!config.inject && !config.prerecall, followTrigger: !!store && !!config.followTrigger, prerecall: !!store && !!config.prerecall, prefix: config.prefixTier ?? 'P46', weight: !!store && !!config.followUpWeight, verify: !!store && !!config.prerecall && !!config.entityCheck, slots: !!store && !!config.memorySlots, card: !!store && !!config.personCard }
  const rules = memoryRules({ ownerName, privateDiaryAudited: audited, memory: !!store, askFirst: !!config.askFirst, timeCalc: !!config.timeCalc, inject: v2.inject, followTrigger: v2.followTrigger, prerecall: v2.prerecall })

  // ---------- 1. 提示词变量 ----------
  ctx.effect(() => ctx.systemPrompt.variable(v('seed'), () =>
    readText(seedPath, `（种子文件读不到。请把这件事告诉${ownerName}。）`)), `her-life: ${v('seed')}`)
  ctx.effect(() => ctx.systemPrompt.variable(v('self'), () =>
    readText(selfPath, '（这里还是空的。你还没有写下自己是谁——不着急，先认识这个世界。）')), `her-life: ${v('self')}`)
  // 变量每个 step 都会求值，所以这里只返回常量或按天缓存的字符串，平时不做 IO
  const ownerViewer = () => ({ person: OWNER_ID, channel: 'private' })
  // 压缩代次：存在记忆库的 kv 里（重启后接着数）；内存里留一份，变量求值时不碰数据库
  let gen = Number(store?.getKv('compaction_gen') ?? '0') || 0
  let prefixIds: string[] = []
  let lastChars = 0
  const tier = PREFIX_TIERS[v2.prefix]
  const stable = store
    ? dailyCache(() => {
      const r = stableLayerWithIds(store!, ownerViewer(), new Date(), {
        ownerName, dates: !!config.timeCalc,
        ...(v2.prefix !== 'P46' ? { caps: tier.caps, maxChars: tier.maxChars } : {}),
        ...(v2.followTrigger ? { followUps: 'count' as const } : {}),
        ...(v2.slots ? { slots: true } : {}),
        ...(v2.card ? { card: true } : {}),
      })
      prefixIds = r.ids
      lastChars = [...r.text].length
      return r.text
    }, () => cacheKey(gen, reviewDay(new Date()).day, lastChars), (e) => log('稳定层生成失败，这一代只放规则：', e instanceof Error ? e.message : e))
    : () => ''
  ctx.effect(() => ctx.systemPrompt.variable(v('memory'), () => {
    const s = stable()
    return s ? `${rules}\n\n${s}` : rules
  }), `her-life: ${v('memory')}`)

  // ---------- 2. 她的工具 ----------
  const writeDiary = writeDiaryTool(lifeDir, books, { ownerName, privateDiaryAudited: audited })

  const proposeSelf = tool({
    name: 'propose_self_change',
    description: '提出对 self.md（我是谁）的修改。必须给出完整的新内容、为什么改、以及至少一段让你这样想的具体经历（时间、和谁、发生了什么）。修改不会马上生效：会先经过审查，确认不违背种子里的红线后才写入。',
    properties: {
      new_self: { type: 'string', description: 'self.md 的完整新内容（不是差异），最多 3000 字' },
      reason: { type: 'string', description: '为什么要这样改' },
      evidence: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, description: '让你这样想的具体经历，每条一句以上' },
    },
    required: ['new_self', 'reason', 'evidence'],
    execute({ new_self, reason, evidence }) {
      const ns = String(new_self ?? '').trim()
      const why = String(reason ?? '').trim()
      const ev = (Array.isArray(evidence) ? evidence : []).map((e) => String(e ?? '').trim()).filter((e) => e.length >= 8)
      if (!ns) return { ok: false, message: '新内容是空的' }
      if (ns.length > 3000) return { ok: false, message: '太长了，self.md 最多 3000 字' }
      if (!why) return { ok: false, message: '要写明为什么改' }
      if (ev.length === 0) return { ok: false, message: '至少要有一段具体经历作为依据（每条至少 8 个字）' }
      const t = beijing()
      const id = t.iso.replace(/[-:+]/g, '').slice(0, 15)
      const rec = { id, created: t.iso, status: 'pending', base_sha: sha(selfPath), reason: why, evidence: ev, new_self: ns }
      writeFileSync(join(lifeDir, 'proposals', id + '.json'), JSON.stringify(rec, null, 2), { mode: 0o600 })
      return { ok: true, message: `已提交（编号 ${id}），审查后生效。` }
    },
  })

  // ---------- 3. 安全：屏蔽名单 + 执行前拦截 ----------
  // 用 deny 而不是 allow：插件层是会话的上一层，allow 会把本插件的工具也遮掉（见 DSH 源码 view()）。
  const own = [writeDiary, proposeSelf, recallDiaryTool(lifeDir, books, { people: () => store?.people() ?? [] })]

  // 危机协议（Z）的状态，启动日志用；三张表放在 memory.db 里，记忆库打不开时不生效（要写日志）
  let crisisInfo = config.crisis ? '已开启但记忆库没开 / 打不开，本次没有生效' : '关'
  // 记忆库的两件工具：单人模式下说话人一律是主人、私聊
  if (store) {
    const db = store
    ctx.effect(() => () => db.close(), 'her-life: memory.db')
    own.push(keepMemoryTool(db, ownerViewer, ownerName, undefined, undefined, { synonyms: !!config.memoryKeys, slots: v2.slots }), recallMemoryTool(db, ownerViewer, undefined, { lifeDir, books }, { wide: v2.prerecall }), followUpTool(db, ownerViewer, undefined, undefined, { keys: v2.followTrigger, loose: !!config.followUpLoose, mid: !!config.followUpMid, weight: v2.weight }))

    // 记忆 v2 读侧：压缩代次（稳定层换代用；J、K 都关时也数，开销只是一次计数）
    if (ctx.on) {
      ctx.effect(() => ctx.on!('session/event', compactionCounter(() => {
        gen++
        try { db.setKv('compaction_gen', String(gen)) } catch (e) { log('记不下压缩代次：', e instanceof Error ? e.message : e) }
        log(`压缩了一次（代次 ${gen}），稳定层下一步换代`)
      })), 'her-life: compaction counter')
    }
    // 开关 Z：危机协议（建三张小表；通知通道按启动时能确定的情况报“可用 / 不可用”）
    let crisis: { watch: CrisisWatch; notify: (n: CrisisNotify) => Promise<boolean> } | undefined
    if (config.crisis) {
      try {
        const watch = new CrisisWatch(db, { ownerId: OWNER_ID, ownerName, ...(config.selfName ? { selfName: config.selfName } : {}), nameOf: (id) => db.nameOf(id) })
        const notifier = makeCrisisNotifier(ctx.tools as unknown as ToolRuntimeLike, config.emergencyContact, log)
        crisis = { watch, notify: (n) => notifier.send(n) }
        crisisInfo = `开 · 通知通道 ${notifier.available ? `可用（${notifier.reason}）` : `不可用（${notifier.reason}）`}`
        if (!notifier.available) log(`危机通知通道：不可用（${notifier.reason}）`)
      } catch (e) {
        crisisInfo = `已开启但建不起来，本次没有生效（${e instanceof Error ? e.message : String(e)}）`
        log('危机协议建不起来：', e instanceof Error ? e.message : e)
      }
    }
    // 开关 J / K / R / Z：每轮“想起来的” / “该问问了” / “现在要注意的”
    if (v2.inject || v2.followTrigger || v2.prerecall || crisis) {
      if (!ctx.on) {
        log('宿主没有 ctx.on：开关 J / K / R / Z 本次不生效')
        if (crisis) crisisInfo = '已开启但宿主没有 ctx.on，本次没有生效'
      } else {
        let create: CreateUserMessage | null = null
        loadCreateUserMessage().then((f) => {
          create = f
          log(f ? '想起来的 / 该问问了：已就绪' : '找不到 @deepseek-ai/dsh-llm 的 createUserMessage：开关 J / K 本次不生效')
        }, (e) => log('加载 createUserMessage 失败：', e instanceof Error ? e.message : e))
        const noticer = makeNoticer({
          store: db, viewer: ownerViewer, inject: v2.inject, followTrigger: v2.followTrigger, prerecall: v2.prerecall, weighted: v2.weight, verify: v2.verify, prefixIds: () => prefixIds,
          names: () => [ownerName], log, ...(config.injectGate ? { gate: config.injectGate } : {}), ...(crisis ? { crisis } : {}),
        })
        ctx.effect(() => ctx.on!('agent/pre-step', preStepHandler(noticer, () => create, log), { prepend: true }), 'her-life: recall notice')
      }
    }
  }
  for (const t of own) {
    ctx.effect(() => ctx.tools.register(t), `her-life: ${t.name}`)
  }

  let globals: string[] = []
  try {
    globals = (ctx.tools.schemas() ?? []).map((d) => d.name).filter((n) => !(OWN_TOOLS as readonly string[]).includes(n))
  } catch (e) {
    log('读全局工具失败：', e instanceof Error ? e.message : e)
  }
  const deny = globals.filter((n) => blocked.has(n))
  try {
    if (deny.length > 0) ctx.effect(() => ctx.tools.restrict({ deny }), 'her-life: restrict deny')
    log('全局工具', globals.length, '个：', globals.join(','), '｜屏蔽：', deny.join(',') || '无')
  } catch (e) {
    log('restrict 失败（由 guard 兜底）：', e instanceof Error ? e.message : e)
  }
  // 兜底：即使屏蔽失败或工具名出现在别处，执行前也拦住
  ctx.effect(() => ctx.tools.guard((exec) => (blocked.has(exec.name) ? `这个会话不允许调用 ${exec.name}` : undefined)), 'her-life: guard')

  log('已挂载：seed', sha(seedPath) ?? '缺失', '· self', sha(selfPath) ?? '空', '· 目录', lifeDir)
  log(`配置：变量 ${v('seed')}/${v('self')}/${v('memory')} · 日记本 ${books.ids.join('/')} · 私人日记留痕 ${audited ? '是' : '否'} · 记忆库 ${memInfo}`)
  log(`记忆 v2：前缀 ${v2.prefix} · 想起来的（J）${v2.inject ? "开" : "关"} · 预翻（R）${v2.prerecall ? "开" : "关"} · 到日子提醒（K）${v2.followTrigger ? "开" : "关"} · 惦记说法（F）${config.followUpLoose ? "0.5.0" : "0.5.1"} · 压缩代次 ${gen} · 有效期（Y）${v2.slots ? "开" : "关"} · 人物卡（T）${v2.card ? "开" : "关"}`)
  log(`危机协议（Z）${crisisInfo}`)
}
